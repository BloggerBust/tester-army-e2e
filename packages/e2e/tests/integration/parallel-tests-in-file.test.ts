import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, runProjectWithConfigFile, workerFakeConfigSource, type RunOptions } from '../helpers/run-project.ts';

/** What one test body or hook wrote down: where it ran, and when. */
interface Mark {
  readonly name: string;
  readonly pid: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Runs one test file on worker processes and returns what its bodies and
 * hooks marked. In the file, `mark(name)` records the process it ran in and
 * when, and `together(name, count)` returns only once `count` tests are
 * inside it at the same time, however loaded the machine is: it fails a
 * test that waits for the others in vain.
 */
async function runFile(body: string, options: { workers: number; config?: string; configSource?: string; runOptions?: Partial<RunOptions> }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-parallel-'));
  const source = `import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'e2e';

async function mark(name: string, hold: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 50))): Promise<void> {
  const start = Date.now();
  await hold();
  writeFileSync(path.join(${JSON.stringify(dir)}, name + '-' + process.pid + '-' + start), JSON.stringify({ name, pid: process.pid, start, end: Date.now() }));
}

async function together(name: string, count: number): Promise<void> {
  await mark(name, async () => {
    writeFileSync(path.join(${JSON.stringify(dir)}, 'inside-' + name), '');
    const deadline = Date.now() + 30_000;
    while (readdirSync(${JSON.stringify(dir)}).filter((entry) => entry.startsWith('inside-')).length < count) {
      if (Date.now() > deadline) throw new Error(name + ' ran alone: fewer than ' + count + ' tests ran at the same time');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
}

${body}
`;
  const { outcome, project } = await runProjectWithConfigFile(
    { 'tests/file.e2e.ts': source },
    { configSource: options.configSource ?? workerFakeConfigSource(options.workers, options.config ?? ''), ...(options.runOptions === undefined ? {} : { runOptions: options.runOptions }) },
  );
  const marks = readdirSync(dir).filter((entry) => !entry.startsWith('inside-')).map((entry) => JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as Mark);
  rmSync(dir, { recursive: true, force: true });
  project.cleanup();
  const named = (name: string): Mark[] => marks.filter((mark) => mark.name === name);
  const one = (name: string): Mark => {
    const [found, ...rest] = named(name);
    if (found === undefined || rest.length > 0) throw new Error(`expected one mark named ${name}, got ${named(name).length}`);
    return found;
  };
  return { outcome, marks, named, one };
}

const FOUR_TESTS = [1, 2, 3, 4].map((n) => `test('t${n}', async () => { await mark('t${n}'); });`).join('\n');
/** Four tests that pass only when all four run at the same time. */
const FOUR_TOGETHER = [1, 2, 3, 4].map((n) => `test('t${n}', async () => { await together('t${n}', 4); });`).join('\n');

describe('parallel tests within one file', () => {
  it(
    'runs a file in order on one worker by default',
    async () => {
      const { outcome, marks, one } = await runFile(FOUR_TESTS, { workers: 4 });
      expect(outcome.exitCode).toBe(0);
      expect(new Set(marks.map((mark) => mark.pid)).size).toBe(1);
      expect(one('t1').end).toBeLessThanOrEqual(one('t2').start);
      expect(one('t3').end).toBeLessThanOrEqual(one('t4').start);
    },
    120_000,
  );

  it(
    'runs the tests of a parallel describe at the same time on separate workers, and reports them in declaration order',
    async () => {
      const { outcome, marks } = await runFile(`test.describe('group', { parallel: true }, () => {\n${FOUR_TOGETHER}\n});`, { workers: 4 });
      expect(outcome.exitCode).toBe(0);
      expect(new Set(marks.map((mark) => mark.pid)).size).toBe(4);
      expect(outcome.report.run.results.map((result) => result.titlePath.at(-1))).toEqual(['t1', 't2', 't3', 't4']);
      assertValidReport(outcome.report);
    },
    120_000,
  );

  it(
    'runs a whole file in parallel from a top-level describe.configure',
    async () => {
      const { outcome, marks } = await runFile(`test.describe.configure({ parallel: true });\n${FOUR_TOGETHER}`, { workers: 4 });
      expect(outcome.exitCode).toBe(0);
      expect(new Set(marks.map((mark) => mark.pid)).size).toBe(4);
    },
    120_000,
  );

  it(
    'runs every file in parallel under fullyParallel, in the config or as the flag, except a file with parallel: false',
    async () => {
      const config = await runFile(FOUR_TOGETHER, { workers: 4, config: '\n  fullyParallel: true,' });
      expect(config.outcome.exitCode).toBe(0);
      expect(new Set(config.marks.map((mark) => mark.pid)).size).toBe(4);

      const flag = await runFile(FOUR_TOGETHER, { workers: 4, runOptions: { fullyParallel: true } });
      expect(flag.outcome.exitCode).toBe(0);
      expect(new Set(flag.marks.map((mark) => mark.pid)).size).toBe(4);

      const optedOut = await runFile(`test.describe.configure({ parallel: false });\n${FOUR_TESTS}`, { workers: 4, config: '\n  fullyParallel: true,' });
      expect(optedOut.outcome.exitCode).toBe(0);
      expect(new Set(optedOut.marks.map((mark) => mark.pid)).size).toBe(1);
    },
    180_000,
  );

  it(
    'keeps a serial group and a parallel: false group in a parallel file on one worker each, in order',
    async () => {
      const { outcome, one } = await runFile(
        `test.describe.configure({ parallel: true });
test('alone', async () => { await mark('alone'); });
test.describe('steps', { serial: true }, () => {
  test('step 1', async () => { await mark('step 1'); });
  test('step 2', async () => { await mark('step 2'); });
});
test.describe('ordered', { parallel: false }, () => {
  test('first', async () => { await mark('first'); });
  test('second', async () => { await mark('second'); });
});`,
        { workers: 4 },
      );
      expect(outcome.exitCode).toBe(0);
      expect(one('step 1').pid).toBe(one('step 2').pid);
      expect(one('step 1').end).toBeLessThanOrEqual(one('step 2').start);
      expect(one('first').pid).toBe(one('second').pid);
      expect(one('first').end).toBeLessThanOrEqual(one('second').start);
      expect(new Set([one('alone').pid, one('step 1').pid, one('first').pid]).size).toBe(3);
      expect(outcome.report.run.serialGroups).toHaveLength(1);
      expect(outcome.report.run.serialGroups[0]!.status).toBe('passed');
    },
    120_000,
  );

  it(
    'keeps one serial group whose title path is declared twice, in a parallel scope and outside one',
    async () => {
      const { outcome } = await runFile(
        `test.describe('outer', () => {
  test.describe('checkout', { serial: true }, () => {
    test('first', async () => { throw new Error('expected'); });
  });
});
test.describe('outer', { parallel: true }, () => {
  test.describe('checkout', { serial: true }, () => {
    test('second', async () => { await mark('second'); });
  });
});`,
        { workers: 2 },
      );
      expect(resultByTitle(outcome, 'first').status).toBe('failed');
      // The group stops at its failed member.
      expect(resultByTitle(outcome, 'second').status).toBe('skipped');
      expect(outcome.report.run.serialGroups.map((group) => [group.status, group.memberTestIds.length])).toEqual([['failed', 2]]);
      assertValidReport(outcome.report);
    },
    120_000,
  );

  it(
    'runs tests with suite hooks in one batch per worker, each batch running the hooks once and sharing its module state',
    async () => {
      const { outcome, marks, named } = await runFile(
        `const withWorker = test.extend<{}, { perWorker: number }>({
  perWorker: [async ({}, use) => { await mark('fixture'); await use(1); }, { scope: 'worker' }],
});
withWorker.describe.configure({ parallel: true });
withWorker.beforeAll(async () => { await mark('beforeAll'); });
withWorker.afterAll(async () => { await mark('afterAll'); });
let ran = 0;
${[1, 2, 3, 4].map((n) => `withWorker('t${n}', async ({ perWorker }) => { ran += 1; await mark('t${n}-ran-' + ran); });`).join('\n')}`,
        { workers: 2 },
      );
      expect(outcome.exitCode).toBe(0);
      const tests = marks.filter((mark) => /^t\d-/.test(mark.name));
      expect(new Set(tests.map((mark) => mark.pid)).size).toBe(2);
      // Each batch imported the file for itself, and its second test saw what its first left.
      expect(tests.map((mark) => mark.name).toSorted()).toEqual(['t1-ran-1', 't2-ran-2', 't3-ran-1', 't4-ran-2']);
      for (const hook of ['beforeAll', 'afterAll', 'fixture']) {
        expect(named(hook)).toHaveLength(2);
        expect(new Set(named(hook).map((mark) => mark.pid)).size).toBe(2);
      }
    },
    120_000,
  );

  it(
    'cuts the file again for the workers prepare reports, so one worker runs the suite hooks once',
    async () => {
      const prepared = (workers: number): string => `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true, preparedWorkers: ${workers} }).engine, app: FAKE_APP }],
  workers: 4,
} satisfies E2EConfig;
`;
      const body = `test.describe.configure({ parallel: true });
test.beforeAll(async () => { await mark('beforeAll'); });
${FOUR_TESTS}`;
      const one = await runFile(body, { workers: 4, configSource: prepared(1) });
      expect(one.outcome.exitCode).toBe(0);
      expect(one.named('beforeAll')).toHaveLength(1);
      const two = await runFile(body, { workers: 4, configSource: prepared(2) });
      expect(two.outcome.exitCode).toBe(0);
      expect(two.named('beforeAll')).toHaveLength(2);
    },
    180_000,
  );

  it(
    'runs the hooks around an ordered group again for that group, in the one import of the file its worker made',
    async () => {
      const { outcome, marks, named } = await runFile(
        `test.describe.configure({ parallel: true });
void mark('imported', async () => {});
test.beforeAll(async () => { await mark('beforeAll'); });
let ran = 0;
for (const group of ['a', 'b', 'c']) {
  test.describe(group, { parallel: false }, () => {
    test('one', async () => { ran += 1; await mark('ran-' + ran); });
    test('two', async () => { ran += 1; await mark('ran-' + ran); });
  });
}`,
        { workers: 2 },
      );
      expect(outcome.exitCode).toBe(0);
      expect(named('beforeAll')).toHaveLength(3);
      const ran = marks.filter((mark) => mark.name.startsWith('ran-'));
      expect(ran).toHaveLength(6);
      for (const pid of new Set(ran.map((mark) => mark.pid))) {
        const counts = ran.filter((mark) => mark.pid === pid).map((mark) => Number(mark.name.slice('ran-'.length)));
        // The groups a worker ran counted on in one module instance.
        expect(counts.toSorted((x, y) => x - y)).toEqual(counts.map((_, index) => index + 1));
        expect(named('imported').filter((mark) => mark.pid === pid)).toHaveLength(1);
      }
    },
    120_000,
  );

  it(
    'retries a failing parallel test on its own and leaves the others passed',
    async () => {
      const { outcome, named, one } = await runFile(
        `test.describe.configure({ parallel: true });
test('t1', async () => { await together('t1', 3); });
test('fails', async () => { await together('fails', 3); throw new Error('always'); });
test('t3', async () => { await together('t3', 3); });`,
        { workers: 3, config: '\n  retries: 1,' },
      );
      expect(outcome.exitCode).toBe(1);
      expect(resultByTitle(outcome, 't1').status).toBe('passed');
      expect(resultByTitle(outcome, 't3').status).toBe('passed');
      expect(resultByTitle(outcome, 'fails').status).toBe('failed');
      expect(resultByTitle(outcome, 'fails').attempts).toHaveLength(2);
      expect(resultByTitle(outcome, 't1').attempts).toHaveLength(1);
      expect(resultByTitle(outcome, 't3').attempts).toHaveLength(1);
      expect(named('fails')).toHaveLength(2);
      const failing = new Set(named('fails').map((mark) => mark.pid));
      expect(failing.has(one('t1').pid) || failing.has(one('t3').pid)).toBe(false);
    },
    120_000,
  );

  it(
    'runs the tests of a parallel file in one import of the file in a run without worker processes',
    async () => {
      const { outcome, project } = await runProject(
        {
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
test.describe.configure({ parallel: true });
let ran = 0;
for (const [index, title] of ['t1', 't2', 't3'].entries()) test(title, async () => { ran += 1; expect(ran).toBe(index + 1); });
test.describe('ordered', { parallel: false }, () => {
  test('first', async () => { ran += 1; });
  test('second', async () => { expect(ran).toBe(4); });
});`,
        },
        {},
      );
      project.cleanup();
      expect(outcome.exitCode).toBe(0);
      expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed']);
    },
    120_000,
  );

  it(
    'runs the tests of a parallel file one at a time in one import of the file when the run has one worker',
    async () => {
      const { outcome, marks, named, one } = await runFile(
        `test.describe.configure({ parallel: true });
void mark('imported', async () => {});
let ran = 0;
${[1, 2, 3].map((n) => `test('t${n}', async () => { ran += 1; await mark('t${n}-ran-' + ran); });`).join('\n')}`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(0);
      const [t1, t2, t3] = [one('t1-ran-1'), one('t2-ran-2'), one('t3-ran-3')];
      expect(new Set([t1, t2, t3].map((mark) => mark.pid)).size).toBe(1);
      expect(named('imported').filter((mark) => mark.pid === t1.pid)).toHaveLength(1);
      expect(t1.end).toBeLessThanOrEqual(t2.start);
      expect(t2.end).toBeLessThanOrEqual(t3.start);
      expect(marks.filter((mark) => mark.pid === t1.pid)).toHaveLength(4);
    },
    120_000,
  );

  it(
    'runs the tests after a failed one on a new worker, in the one import of the file that worker makes',
    async () => {
      const { outcome, named, one } = await runFile(
        `test.describe.configure({ parallel: true });
void mark('imported', async () => {});
let ran = 0;
test('t1', async () => { ran += 1; await mark('t1-ran-' + ran); });
test('fails', async () => { ran += 1; await mark('fails-ran-' + ran); throw new Error('always'); });
test('t3', async () => { ran += 1; await mark('t3-ran-' + ran); });
test('t4', async () => { ran += 1; await mark('t4-ran-' + ran); });`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(1);
      expect(resultByTitle(outcome, 'fails').status).toBe('failed');
      const failed = one('t1-ran-1').pid;
      expect(one('fails-ran-2').pid).toBe(failed);
      const next = one('t3-ran-1').pid;
      expect(next).not.toBe(failed);
      expect(one('t4-ran-2').pid).toBe(next);
      for (const pid of [failed, next]) expect(named('imported').filter((mark) => mark.pid === pid)).toHaveLength(1);
    },
    120_000,
  );
  it(
    'sets up a worker fixture the file declares one time for the tests a worker runs apart',
    async () => {
      const { outcome, marks, named } = await runFile(
        `const withDatabase = test.extend<object, { database: string }>({
  database: [async ({ platform }, use) => {
    await mark('database', async () => {});
    await use(platform);
  }, { scope: 'worker' }],
});
test.describe.configure({ parallel: true });
${[1, 2, 3].map((n) => `withDatabase('t${n}', async ({ database }) => { await mark('t${n}-' + database); });`).join('\n')}`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(0);
      expect(marks.filter((mark) => mark.name.startsWith('t'))).toHaveLength(3);
      expect(named('database')).toHaveLength(1);
    },
    120_000,
  );
  it(
    'keeps the one import of the file across a serial group, which imports the file for itself',
    async () => {
      const { outcome, named, one } = await runFile(
        `test.describe.configure({ parallel: true });
void mark('imported', async () => {});
let ran = 0;
test('t1', async () => { ran += 1; await mark('t1-ran-' + ran); });
test.describe('group', { serial: true }, () => {
  test('member', async () => { await mark('member'); });
});
test('t2', async () => { ran += 1; await mark('t2-ran-' + ran); });`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(0);
      const worker = one('member').pid;
      expect(one('t1-ran-1').pid).toBe(worker);
      expect(one('t2-ran-2').pid).toBe(worker);
      // The tests' import, and the group's own.
      expect(named('imported').filter((mark) => mark.pid === worker)).toHaveLength(2);
    },
    120_000,
  );

  it(
    'imports the file again for the tests after a beforeAll that failed',
    async () => {
      const { outcome, one } = await runFile(
        `test.describe.configure({ parallel: true });
let ran = 0;
test.describe('group', () => {
  test.beforeAll(async () => { ran += 10; await mark('beforeAll'); throw new Error('always'); });
  test('member', async () => {});
});
test('after', async () => { ran += 1; await mark('after-ran-' + ran); });`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(1);
      expect(resultByTitle(outcome, 'after').status).toBe('passed');
      expect(one('beforeAll').end).toBeLessThanOrEqual(one('after-ran-1').start);
      expect(one('after-ran-1').pid).toBe(one('beforeAll').pid);
    },
    120_000,
  );
  it(
    'imports the file again for the unit after one in which a test failed as expected, whatever an earlier realm of it kept',
    async () => {
      const { outcome, named, one } = await runFile(
        `void mark('imported', async () => {});
let ran = 0;
test('before the group', async () => { ran += 1; await mark('before-ran-' + ran); });
test.describe('group', { serial: true }, () => {
  test('member', async () => { await mark('member'); });
});
test.fail('fails as expected', async () => { ran += 1; throw new Error('expected'); });
test.describe('apart', { parallel: true }, () => {
  test('after the failure', async () => { ran += 1; await mark('after-ran-' + ran); });
});`,
        { workers: 1 },
      );
      expect(outcome.exitCode).toBe(0);
      const worker = one('before-ran-1').pid;
      expect(one('after-ran-1').pid).toBe(worker);
      // The tests before the group, the group, the expected failure, and the test apart.
      expect(named('imported').filter((mark) => mark.pid === worker)).toHaveLength(4);
    },
    120_000,
  );

  it(
    'runs the repeats of a parallel test one after another on one worker, while the tests run at the same time',
    async () => {
      const { outcome, named } = await runFile(
        `test.describe.configure({ parallel: true });
${[1, 2].map((n) => `test('t${n}', async () => { await together('t${n}', 2); await mark('t${n}-ran'); });`).join('\n')}`,
        { workers: 4, runOptions: { repeatEach: 2 } },
      );
      expect(outcome.exitCode).toBe(0);
      for (const title of ['t1-ran', 't2-ran']) {
        const [first, second] = named(title).toSorted((a, b) => a.start - b.start);
        expect(named(title)).toHaveLength(2);
        expect(first!.pid).toBe(second!.pid);
        expect(first!.end).toBeLessThanOrEqual(second!.start);
      }
    },
    120_000,
  );

  it(
    'keeps no import of a file that was not cut',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          // The second file passes only if the worker let go of what the first one held.
          'tests/a.e2e.ts': `import { test } from 'e2e';
const held = new FinalizationRegistry<string>(() => { (globalThis as { released?: boolean }).released = true; });
test.describe('holds', () => {
  const big = new Uint8Array(8 * 1024 * 1024);
  held.register(big, 'big');
  test('a', async () => { big[0] = 1; });
});`,
          'tests/b.e2e.ts': `import { expect, test } from 'e2e';
test('b', async () => {
  await expect.poll(() => { (globalThis as { gc?: () => void }).gc?.(); return (globalThis as { released?: boolean }).released; }, { timeout: 20_000 }).toBe(true);
});`,
        },
        { configSource: workerFakeConfigSource(1), runOptions: { env: { NODE_OPTIONS: '--expose-gc' } } },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );
});
