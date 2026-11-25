import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('test.extend fixtures', () => {
  it(
    'sets fixtures up in order, hands them to hooks and the body, and tears them down last first',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test as base } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

const test = base
  .extend<{ first: string }>({
    first: async ({ platform }, use) => {
      log('setup:first:' + platform);
      await use('one');
      log('teardown:first');
    },
  })
  .extend<{ second: string }>({
    // A later definition reads an earlier one.
    second: async ({ first }, use) => {
      log('setup:second:' + first);
      await use(first + '-two');
      log('teardown:second');
    },
  });

// Hooks read the fixtures of the test they wrap, so these stay in a group
// whose tests all carry the chain.
test.describe('chain', () => {
  test.beforeEach(({ second }) => log('beforeEach:' + second));
  test.afterEach(({ first }) => log('afterEach:' + first));

  test('sees the values', async ({ first, second, app }) => {
    await app.open();
    log('body:' + first + ':' + second);
  });

  test('fails in the body', async ({ second }) => {
    log('body:failing:' + second);
    throw new Error('body boom');
  });
});

const leaky = base.extend<{ leaky: string }>({
  leaky: async ({}, use) => {
    await use('leaky');
    throw new Error('teardown boom');
  },
});
leaky('teardown fails after a pass', async ({ leaky }) => {
  log('body:' + leaky);
});

const silent = base.extend<{ silent: string }>({
  silent: async () => {
    log('setup:silent');
  },
});
silent('never calls use', async ({ silent }) => {
  log('unreachable:' + silent);
});
`;
      const logPath = path.join('/tmp', `e2e-extend-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const { outcome, project } = await runProject(
        { 'tests/extend.e2e.ts': file },
        { config: engineConfig(createFakeEngine({ fixtures: true }).engine) },
      );
      assertValidReport(outcome.report);

      const passes = resultByTitle(outcome, 'sees the values');
      expect(passes.status).toBe('passed');

      const fails = resultByTitle(outcome, 'fails in the body');
      expect(fails.status).toBe('failed');
      expect(fails.attempts[0]!.error?.phase).toBe('body');
      expect(fails.attempts[0]!.error?.message).toContain('body boom');
      expect(fails.attempts[0]!.secondaryErrors).toEqual([]);

      const leaky = resultByTitle(outcome, 'teardown fails after a pass');
      expect(leaky.status).toBe('failed');
      expect(leaky.attempts[0]!.error?.phase).toBe('afterEach');
      expect(leaky.attempts[0]!.error?.message).toContain('teardown boom');

      const silent = resultByTitle(outcome, 'never calls use');
      expect(silent.status).toBe('failed');
      expect(silent.attempts[0]!.error?.phase).toBe('beforeEach');
      expect(silent.attempts[0]!.error?.code).toBe('TEST_SETUP_FAILED');
      expect(silent.attempts[0]!.error?.message).toContain('fixture "silent" returned without calling use()');

      expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual([
        'setup:first:fake',
        'setup:second:one',
        'beforeEach:one-two',
        'body:one:one-two',
        'afterEach:one',
        'teardown:second',
        'teardown:first',
        'setup:first:fake',
        'setup:second:one',
        'beforeEach:one-two',
        'body:failing:one-two',
        'afterEach:one',
        'teardown:second',
        'teardown:first',
        'body:leaky',
        'setup:silent',
      ]);
      project.cleanup();
    },
    120_000,
  );

  it(
    'releases a fixture that reaches use() after the attempt timed out under its setup',
    async () => {
      const file = `import { appendFileSync } from 'node:fs';
import { test as base } from 'e2e';

const log = (entry: string) => appendFileSync(process.env.HOOK_LOG!, entry + '\\n');

const test = base.extend<{ slow: string }>({
  slow: async ({}, use) => {
    log('setup:slow');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await use('slow');
    log('teardown:slow');
  },
}).extend<{ later: string }>({
  later: async ({}, use) => {
    log('unreachable:later');
    await use('later');
  },
});

test.beforeEach(() => log('unreachable:beforeEach'));
test('times out in setup', { timeout: 500 }, async ({ slow, later }) => {
  log('unreachable:body:' + slow + later);
});
`;
      const logPath = path.join('/tmp', `e2e-extend-late-${Date.now()}.log`);
      process.env['HOOK_LOG'] = logPath;
      const fake = createFakeEngine({
        observe: async () => {
          // Keep failure capture in flight until the timed-out fixture reaches use().
          await new Promise((resolve) => setTimeout(resolve, 800));
        },
      });
      const { outcome, project } = await runProject({ 'tests/late.e2e.ts': file }, { config: engineConfig(fake.engine) });
      const result = resultByTitle(outcome, 'times out in setup');
      expect(result.status).toBe('timed-out');
      expect(result.attempts[0]!.error?.phase).toBe('beforeEach');
      // The abandoned setup is still running in this process; its `use` is
      // released on arrival, so the teardown lands after the run finished.
      await vi.waitFor(
        () => expect(readFileSync(logPath, 'utf8').trim().split('\n')).toEqual(['setup:slow', 'teardown:slow']),
        { timeout: 10_000, interval: 100 },
      );
      project.cleanup();
    },
    120_000,
  );

  it('does not run later hooks or the body after a beforeEach times out', async () => {
    const events: string[] = [];
    const record = (entry: string) => { events.push(entry); };
    process.on('e2e-late-hook-progress', record);
    let finishHook: () => void = () => undefined;
    const hookFinished = new Promise<void>((resolve) => { finishHook = resolve; });
    process.once('e2e-late-hook-finished', finishHook);
    const file = `import { test } from 'e2e';

test.beforeEach(async () => {
  process.emit('e2e-late-hook-progress', 'started');
  await new Promise<void>((resolve) => process.once('e2e-late-hook-release', resolve));
  process.emit('e2e-late-hook-progress', 'finished');
  process.emit('e2e-late-hook-finished');
});
test.beforeEach(() => process.emit('e2e-late-hook-progress', 'later hook'));
test('times out in hook', { timeout: 100 }, async () => {
  process.emit('e2e-late-hook-progress', 'body');
});
`;
    const fake = createFakeEngine({
      observe: async () => {
        process.emit('e2e-late-hook-release');
        await hookFinished;
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    });
    try {
      const { outcome, project } = await runProject({ 'tests/late-hook.e2e.ts': file }, { config: engineConfig(fake.engine) });
      try {
        const result = resultByTitle(outcome, 'times out in hook');
        expect(result.status).toBe('timed-out');
        expect(result.attempts[0]!.error?.phase).toBe('beforeEach');
        expect(events).toEqual(['started', 'finished']);
      } finally {
        project.cleanup();
      }
    } finally {
      process.off('e2e-late-hook-progress', record);
      process.off('e2e-late-hook-finished', finishHook);
    }
  });
  it('aborts the engine calls of a body that resumes after its timeout, with a fixture teardown in between', async () => {
    const file = `import { test as base } from 'e2e';

const test = base.extend<{ guard: void }>({
  guard: [async ({}, use) => { await use(); }, { auto: true }],
});

test('times out', { timeout: 300 }, async ({ app }) => {
  await new Promise<void>((resolve) => process.once('e2e-late-body-release', resolve));
  await app.open('/late').catch(() => undefined);
  process.emit('e2e-late-body-finished');
});
test('next test', async ({ app }) => {
  await app.open('/next');
  const finished = new Promise<void>((resolve) => process.once('e2e-late-body-finished', resolve));
  process.emit('e2e-late-body-release');
  await finished;
});
`;
    const fake = createFakeEngine();
    const { outcome, project } = await runProject({ 'tests/late-body.e2e.ts': file }, { config: engineConfig(fake.engine) });
    try {
      const abandoned = resultByTitle(outcome, 'times out');
      expect(abandoned.status).toBe('timed-out');
      expect(resultByTitle(outcome, 'next test').status).toBe('passed');
      // The teardown's budget was the last one the attempt entered, and it never aborted.
      const late = fake.operations.filter((operation) => operation.attemptId === abandoned.attempts[0]!.id && operation.method.endsWith('/late)'));
      expect(late.map((operation) => operation.abortedAtCall)).toEqual([true]);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('aborts the engine calls of a body that resumes while its own teardown runs', async () => {
    const file = `import { test } from 'e2e';

test.afterEach(async () => {
  const finished = new Promise<void>((resolve) => process.once('e2e-own-teardown-finished', resolve));
  process.emit('e2e-own-teardown-release');
  await finished;
});
test('times out', { timeout: 300 }, async ({ app }) => {
  await new Promise<void>((resolve) => process.once('e2e-own-teardown-release', resolve));
  await app.open('/late').catch(() => undefined);
  process.emit('e2e-own-teardown-finished');
});
`;
    const fake = createFakeEngine();
    const { outcome, project } = await runProject({ 'tests/own-teardown.e2e.ts': file }, { config: engineConfig(fake.engine) });
    try {
      expect(resultByTitle(outcome, 'times out').status).toBe('timed-out');
      // The hook's budget is live while the body resumes; the body's own phase is over.
      const late = fake.operations.filter((operation) => operation.method.endsWith('/late)'));
      expect(late.map((operation) => operation.abortedAtCall)).toEqual([true]);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('aborts the engine calls an abandoned body makes through a worker fixture during the next test', async () => {
    const file = `import { test as base } from 'e2e';

const test = base.extend<{}, { nav: { late(): Promise<void> } }>({
  nav: [async ({ app }, use) => { await use({ late: () => app.open('/late') }); }, { scope: 'worker' }],
});

test('times out', { timeout: 300 }, async ({ nav }) => {
  await new Promise<void>((resolve) => process.once('e2e-late-worker-release', resolve));
  await nav.late().catch(() => undefined);
  process.emit('e2e-late-worker-finished');
});
test('next test', async ({ app, nav }) => {
  await app.open('/next');
  const finished = new Promise<void>((resolve) => process.once('e2e-late-worker-finished', resolve));
  process.emit('e2e-late-worker-release');
  await finished;
});
`;
    const fake = createFakeEngine({ isolation: 'worker' });
    const { outcome, project } = await runProject({ 'tests/late-worker.e2e.ts': file }, { config: engineConfig(fake.engine) });
    try {
      expect(resultByTitle(outcome, 'times out').status).toBe('timed-out');
      expect(resultByTitle(outcome, 'next test').status).toBe('passed');
      // The worker fixture's `app` is the running test's, whoever calls it.
      const late = fake.operations.filter((operation) => operation.method.endsWith('/late)'));
      expect(late.map((operation) => operation.abortedAtCall)).toEqual([true]);
    } finally {
      project.cleanup();
    }
  }, 120_000);
});
