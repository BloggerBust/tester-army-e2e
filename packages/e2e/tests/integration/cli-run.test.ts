/**
 * `e2e run` and `e2e list` through the built CLI on the fake engine, for what
 * only the process boundary decides: the exit code a crashed worker maps to,
 * shards that split one selection between two machines, the defaults a
 * worker resolves for itself when `CI` is set, and where a run error prints
 * when no reporter prints to the terminal.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** A config on the fake engine, `behavior` its `createFakeEngine` options, `extra` more config keys. */
function fakeConfig(behavior = '{}', extra = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine(${behavior}).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',${extra}
} satisfies E2EConfig;
`;
}

/** A fixture project removed after the test. */
function fixture(files: Record<string, string>): FixtureProject {
  const created = createProject(files);
  projects.push(created);
  return created;
}

/** Writes a project and runs one CLI command in it; `CI` is unset unless `env` sets it. */
function cli(files: Record<string, string>, args: readonly string[], env: Record<string, string> = {}) {
  const created = fixture(files);
  return { project: created, ...rerun(created, args, env) };
}

/** Runs one more CLI command in an existing project. */
function rerun(existing: FixtureProject, args: readonly string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: existing.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { exitCode: result.status, output: result.stdout + result.stderr, stdout: result.stdout, stderr: result.stderr };
}

/** The report the last run wrote. */
function reportOf(ran: FixtureProject): Report1Document {
  const report = JSON.parse(readFileSync(path.join(ran.dir, '.e2e', 'report.json'), 'utf8')) as Report1Document;
  assertValidReport(report);
  return report;
}

/** Keeps a process alive the way a database pool opened at import does. */
const openTimer = 'setInterval(() => {}, 60_000);\n';

const test = (title: string, body = '') => `import { test } from 'e2e';\ntest('${title}', async ({ app }) => {\n  await app.open();\n  ${body}\n});\n`;

describe('the run command through the CLI', () => {
  it('exits 3 when a worker dies under a test', () => {
    const { project, exitCode } = cli(
      { 'e2e.config.ts': fakeConfig(), 'tests/crash.e2e.ts': test('crashes the worker', 'process.exit(7);') },
      ['run'],
    );
    expect(exitCode).toBe(3);
    const report = reportOf(project);
    expect(report.run.exitCode).toBe(3);
    expect(report.run.results.map((result) => result.attempts[0]?.error?.code)).toEqual(['WORKER_CRASH']);
  });

  it('splits one selection into shards that cover every test once, each with the setup its tests need', () => {
    const files: Record<string, string> = {
      'e2e.config.ts': fakeConfig('{ state: true }'),
      'tests/auth.setup.e2e.ts': `import { test } from 'e2e';\ntest.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {\n  await app.open();\n  await session.save('member');\n});\n`,
    };
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      files[`tests/${name}.e2e.ts`] = `import { test } from 'e2e';\ntest('${name}', { session: 'member' }, async ({ app }) => {\n  await app.open();\n});\n`;
    }
    const sharded = fixture(files);
    const listed = (shard: string) => {
      const { exitCode, stdout } = rerun(sharded, ['list', '--reporter', 'json', '--shard', shard]);
      expect(exitCode).toBe(0);
      const { pairs } = JSON.parse(stdout) as { pairs: { title: string; kind: string }[] };
      return pairs;
    };
    const [first, second] = [listed('1/2'), listed('2/2')];
    const tests = (pairs: { title: string; kind: string }[]) => pairs.filter((pair) => pair.kind === 'test').map((pair) => pair.title);
    expect([...tests(first), ...tests(second)].toSorted()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(tests(first).filter((title) => tests(second).includes(title))).toEqual([]);
    expect(tests(first).length).toBeGreaterThan(0);
    expect(tests(second).length).toBeGreaterThan(0);
    for (const pairs of [first, second]) {
      expect(pairs.filter((pair) => pair.kind === 'setup').map((pair) => pair.title)).toEqual(['sign in']);
    }

    const ran = rerun(sharded, ['run', '--shard', '2/2']);
    expect(ran.exitCode).toBe(0);
    const executed = reportOf(sharded).run.results.filter((result) => result.attempts.length > 0);
    expect(executed.map((result) => result.titlePath.at(-1)).toSorted()).toEqual(['sign in', ...tests(second)].toSorted());
  });

  it('fails a wrong locator and a wrong expectation at the timeout flags, not the config\'s, and a call\'s own timeout still wins', () => {
    const { project, exitCode } = cli(
      {
        'e2e.config.ts': fakeConfig('{ locate: () => [] }', '\n  actionTimeout: 30_000,\n  assertionTimeout: 30_000,'),
        'tests/timeouts.e2e.ts': `import { expect, test } from 'e2e';
test('taps a button that is not there', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Submit now' }).tap();
});
test('expects a heading that is not there', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});
test('taps with its own timeout', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Submit now' }).tap({ timeout: 1_500 });
});
`,
      },
      ['run', '--action-timeout', '400', '--assertion-timeout', '300'],
    );
    expect(exitCode).toBe(1);
    const results = reportOf(project).run.results;
    /** The failed step of the test titled `title`, with the error its attempt ended on. */
    const failed = (title: string) => {
      const attempt = results.find((result) => result.titlePath.at(-1) === title)?.attempts.at(-1);
      const step = attempt?.steps.find((candidate) => candidate.status !== 'passed');
      if (attempt === undefined || step === undefined) throw new Error(`no failed step in ${title}`);
      return { error: attempt.error, step };
    };
    // The worker is a child process that resolves the config again: the flags reach it, or these wait 30 s.
    const tap = failed('taps a button that is not there');
    expect(tap.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(tap.error?.details?.waitedMs).toBeGreaterThanOrEqual(400);
    expect(tap.step.durationMs).toBeLessThan(5_000);
    const assertion = failed('expects a heading that is not there');
    expect(assertion.error?.code).toBe('ASSERTION_FAILED');
    expect(assertion.step.durationMs).toBeGreaterThanOrEqual(300);
    expect(assertion.step.durationMs).toBeLessThan(5_000);
    const own = failed('taps with its own timeout');
    expect(own.error?.code).toBe('LOCATOR_NOT_FOUND');
    expect(own.error?.details?.waitedMs).toBeGreaterThanOrEqual(1_500);
    expect(own.step.durationMs).toBeLessThan(5_000);
  });

  it('under CI, refuses a focused test and retries a failure once', () => {
    const focused = cli(
      { 'e2e.config.ts': fakeConfig(), 'tests/only.e2e.ts': `import { test } from 'e2e';\ntest.only('focused', async () => {});\ntest('other', async () => {});\n` },
      ['run'],
      { CI: 'true' },
    );
    expect(focused.exitCode).toBe(2);
    expect(focused.output).toContain('ONLY_IN_CI');

    const flaky = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/flaky.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('fails once', async ({ app }) => {
  await app.open();
  const marker = new URL('./failed-once', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('first attempt fails');
  }
});
`,
      },
      ['run'],
      { CI: 'true' },
    );
    expect(flaky.exitCode).toBe(0);
    const [result] = reportOf(flaky.project).run.results;
    expect(result?.status).toBe('flaky');
    expect(result?.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
  });

  it('ends run and list with their exit codes when the config and a test file leave a timer open', () => {
    const project = fixture({
      'e2e.config.ts': fakeConfig() + openTimer,
      'tests/pass.e2e.ts': test('passes') + openTimer,
      'tests/fail.e2e.ts': test('fails', "throw new Error('expected failure');") + openTimer,
    });
    expect(rerun(project, ['run', 'tests/pass.e2e.ts']).exitCode).toBe(0);
    expect(reportOf(project).run.exitCode).toBe(0);
    expect(rerun(project, ['run', 'tests/fail.e2e.ts']).exitCode).toBe(1);
    const listed = rerun(project, ['list']);
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain('passes');
  });

  it('exits 3 when a passed test failed its cleanup and the config leaves a timer open', () => {
    const { exitCode } = cli(
      {
        'e2e.config.ts': fakeConfig("{ onEndAttempt() { throw new Error('cleanup failed'); } }") + openTimer,
        'tests/pass.e2e.ts': test('passes'),
      },
      ['run'],
    );
    expect(exitCode).toBe(3);
  });

  it('exits 0 with the whole json report on stdout when a test file leaves a timer open', () => {
    const titles = Array.from({ length: 400 }, (_, index) => `test number ${index}`);
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/many.e2e.ts': `import { test } from 'e2e';\n${openTimer}for (const title of ${JSON.stringify(titles)}) test(title, async () => {});\n`,
      },
      ['run', '--reporter', 'json'],
    );
    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.results).toHaveLength(titles.length);
  });

  it('prints dot verdicts, failure diagnostics, and counts with one mark per selected result', () => {
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig('{}', "reporters: ['dot'],"),
        'tests/dot.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('selected pass', () => {});
test('selected retry', { retries: 1 }, () => {
  const marker = new URL('./first-attempt', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('retry this test');
  }
});
test('selected failure', () => { throw new Error('fails'); });
test.skip('selected skip', () => {});
test('left out', () => {});
`,
      },
      ['run', '--grep', 'selected'],
    );
    expect(exitCode).toBe(1);
    const marks = stdout.split('\n').filter((line) => /^[.~FTI-]+$/u.test(line)).join('');
    expect([...marks].toSorted()).toEqual(['-', '.', 'F', '~']);
    expect(stdout).toContain('Failed Tests');
    expect(stdout).toContain('selected failure');
    expect(stdout).toContain('fails');
    expect(stdout).toMatch(/tests\/dot\.e2e\.ts:\d+/u);
    expect(stdout).toMatch(/Tests\s+1 failed.*1 passed.*1 flaky.*1 skipped/u);
  });

  it('keeps dot progress and test logs on stderr when the CLI also requests JSON', () => {
    const { exitCode, stdout, stderr } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/dot.e2e.ts': `import { test } from 'e2e';
test('first', () => {});
test('second', () => { console.log('test log'); });
`,
      },
      ['run', '--reporter', 'dot,json'],
    );
    expect(exitCode).toBe(0);
    assertValidReport(JSON.parse(stdout));
    expect(stderr).toContain('.\ntest log\n.\n');
  });

  it('prints one progress row per selected result', () => {
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig('{}', "reporters: ['line'],"),
        'tests/line.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('selected pass', () => {});
test('selected retry', { retries: 1 }, () => {
  const marker = new URL('./first-attempt', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('retry this test');
  }
});
test.skip('selected skip', () => {});
test('left out', () => {});
`,
      },
      ['run', '--grep', 'selected'],
    );
    expect(exitCode).toBe(0);
    const rows = stdout.split('\n').filter((line) => /^\[\d+\/\d+\] \[/u.test(line));
    expect(rows.map((row) => row.slice(0, 6))).toEqual(['[1/3] ', '[2/3] ', '[3/3] ']);
    const verdicts = rows.map((row) => row.replace(/^\[\d\/3\] \[fake\] tests\/line\.e2e\.ts > /u, ''));
    expect(verdicts.toSorted()).toEqual(['selected pass (passed)', 'selected retry (flaky)', 'selected skip (skipped)']);
    expect(stdout.split('\n').filter((line) => line.includes('selected pass'))).toEqual(rows.filter((row) => row.includes('selected pass')));
    expect(stdout).toMatch(/Tests\s+1 passed.*1 flaky.*1 skipped/u);
  });

  it('reports a selected skip when engine preparation fails before the plan', () => {
    const config = `import { defineEngine } from 'e2e/engine';
const engine = defineEngine({
  name: 'fake', version: '1.0.0', spiVersion: 1,
  async prepare() { throw new Error('fixture preparation failed'); },
});
export default { targets: [{ name: 'fake', platform: 'fake', engine }] };
`;
    const { exitCode, stdout, stderr } = cli({
      'e2e.config.ts': config,
      'tests/prepare.e2e.ts': `import { test } from 'e2e';
test.skip('registered skip', () => {});
test('scheduled', () => {});
`,
    }, ['run', '--reporter', 'line,json']);
    expect(exitCode, stderr).toBe(3);
    const report = JSON.parse(stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.errors).toEqual([expect.objectContaining({ phase: 'launch', message: expect.stringContaining('fixture preparation failed') })]);
    expect(report.run.results).toContainEqual(expect.objectContaining({ titlePath: ['registered skip'], selected: true, status: 'skipped' }));
    expect(stderr).toMatch(/^\[1\/\?\] \[fake\] tests\/prepare\.e2e\.ts > registered skip \(skipped\)$/mu);
  });

  it('prints line failures as they finish and recaps each with its trace', () => {
    const { project, exitCode, stdout, stderr } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/line.e2e.ts': `import { expect, test } from 'e2e';
test('wrong', () => {
  console.log('test log');
  expect(1).toBe(2);
});
test('later', () => {
  console.log('later test log');
  expect(3).toBe(4);
});
`,
      },
      ['run', '--reporter', 'line,json'],
    );
    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.exitCode).toBe(1);
    expect(report.run.results.map((result) => [result.titlePath, result.status, result.attempts.at(-1)?.error?.code])).toEqual([
      [['wrong'], 'failed', 'ASSERTION_FAILED'],
      [['later'], 'failed', 'ASSERTION_FAILED'],
    ]);
    const rows = stderr.split('\n').filter((line) => /^\[\d+\/\d+\] \[/u.test(line));
    expect(rows).toEqual([
      '[1/2] [fake] tests/line.e2e.ts > wrong (failed)',
      '[2/2] [fake] tests/line.e2e.ts > later (failed)',
    ]);
    const blocks = [...stderr.matchAll(/^ FAIL .+ > (.+)$/gmu)];
    expect(blocks.map(([, title]) => title)).toEqual(['wrong', 'later']);
    const laterLog = stderr.indexOf('\nlater test log\n');
    const recapStart = stderr.search(/^ +Failed +×/mu);
    expect(laterLog).toBeGreaterThan(stderr.indexOf(rows[0]!));
    expect(recapStart).toBeGreaterThan(stderr.indexOf(rows[1]!));
    const firstDetails = stderr.slice(stderr.indexOf(rows[0]!), laterLog);
    const secondDetails = stderr.slice(stderr.indexOf(rows[1]!), recapStart);
    expect(firstDetails).toMatch(/^ FAIL .*wrong$/mu);
    expect(firstDetails).toContain('ASSERTION_FAILED: expected 1 to be 2');
    expect(firstDetails).toMatch(/\d+\|\s+expect\(1\)\.toBe\(2\)/u);
    expect(secondDetails).toMatch(/^ FAIL .*later$/mu);
    expect(secondDetails).toContain('ASSERTION_FAILED: expected 3 to be 4');
    expect(secondDetails).toMatch(/\d+\|\s+expect\(3\)\.toBe\(4\)/u);
    expect(stderr).toMatch(/^test log$/mu);

    const recap = stderr.slice(recapStart);
    const traces = [...recap.matchAll(/^ *(?:Failed +)?× \|fake\| tests\/line\.e2e\.ts:\d+ > (.+)\n +ASSERTION_FAILED: [^\n]+\n +trace (\S+\/trace\.md)$/gmu)];
    expect(traces.map(([, title]) => title)).toEqual(['wrong', 'later']);
    for (const [, title, trace] of traces) {
      expect(readFileSync(path.join(project.dir, trace!), 'utf8')).toMatch(`# ✗ ${title}\n`);
    }
  });

  it('prints a run error on stderr once, whichever reporters run, and keeps the json document whole', () => {
    const project = fixture({
      'e2e.config.ts': fakeConfig(),
      'tests/broken.e2e.ts': "import { test } from 'e2e';\ntest('broken', async () => { const text = 'unterminated; });\n",
    });
    const reason = /COLLECTION_ERROR[\s\S]*failed to collect tests\/broken\.e2e\.ts: .*Unterminated string/u;
    const timesNamed = (text: string) => text.split('failed to collect tests/broken.e2e.ts').length - 1;
    for (const reporter of ['junit', 'markdown']) {
      const ran = rerun(project, ['run', '--reporter', reporter]);
      expect(ran.exitCode, reporter).toBe(2);
      expect(ran.stderr, reporter).toMatch(reason);
      expect(timesNamed(ran.output), reporter).toBe(1);
    }
    const json = rerun(project, ['run', '--reporter', 'json']);
    expect(json.exitCode).toBe(2);
    const report = JSON.parse(json.stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.errors.map((error) => error.code)).toEqual(['COLLECTION_ERROR']);
    expect(json.stderr).toMatch(reason);
    const list = rerun(project, ['run', '--reporter', 'list,junit']);
    expect(list.exitCode).toBe(2);
    expect(list.stdout).toMatch(reason);
    expect(timesNamed(list.output)).toBe(1);
    const line = rerun(project, ['run', '--reporter', 'line']);
    expect(line.exitCode).toBe(2);
    expect(line.stdout).toContain('Run Errors');
    expect(line.stdout).toMatch(reason);
    expect(timesNamed(line.output)).toBe(1);
    expect(line.stdout).not.toMatch(/^\[[^\n/]+\/[^\n]+\] \[/mu);
  });
});

it.each(['config', 'CLI'])('keeps explore logs on stderr with line and JSON reporters from %s', (source) => {
  const config = `import { line, json } from 'e2e/reporters';
import { extracted, installFakeModel } from '../../helpers/fake-model.ts';
console.log('config log');
` + fakeConfig('{}', `
  agents: {
    default: { model: installFakeModel(() => extracted({ decision: 'finish', title: '', instruction: '', summary: 'Finished' })) },
  },
  reporters: [${source === 'config' ? 'line(), json(),' : ''}
  {
    name: 'progress logger',
    onEvent(event) {
      if (event.type === 'test-finished') console.log('custom reporter log');
    },
  }],
`);
  const { exitCode, stdout, stderr } = cli(
    { 'e2e.config.ts': config },
    ['explore', 'Check the app', '--config', 'e2e.config.ts', ...(source === 'CLI' ? ['--reporter', 'line,json'] : [])],
  );
  expect(exitCode, stdout + stderr).toBe(0);
  const report = JSON.parse(stdout) as Report1Document;
  assertValidReport(report);
  expect(report.run.results.map((result) => result.status)).toEqual(['passed']);
  expect(stderr).toMatch(/^\[1\/1\] \[fake\] explore > Check the app \(passed\)$/mu);
  expect(stderr).toMatch(/^config log$/mu);
  expect(stderr).toMatch(/^custom reporter log$/mu);
});

describe('fixture rules through the CLI', () => {
  const SUPPORT = `import { test as base } from 'e2e';

export const test = base.extend<{ workspace: string }>({
  workspace: async ({}, use) => {
    await use('w');
  },
});
`;

  /** The run's one error for `files`, through `e2e run`. */
  function collectionError(files: Record<string, string>): string {
    const ran = cli({ 'e2e.config.ts': fakeConfig('{ fixtures: true }'), 'tests/support.ts': SUPPORT, ...files }, ['run', '--reporter', 'json']);
    expect(ran.exitCode).toBe(2);
    const report = JSON.parse(ran.stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.results).toEqual([]);
    expect(report.run.errors.map((error) => error.code)).toEqual(['COLLECTION_ERROR']);
    return report.run.errors[0]!.message;
  }

  it('names the file and line of the code that breaks a rule', () => {
    const header = "import { test } from './support.ts';\n\n";
    expect(collectionError({ 'tests/a.e2e.ts': `${header}test('fine', async ({ workspace }) => void workspace);\n\ntest('whole', async (fixtures) => {\n  void fixtures;\n});\n` })).toMatch(
      /^tests\/a\.e2e\.ts:5: test "whole" must destructure its first parameter/,
    );
    expect(collectionError({ 'tests/a.e2e.ts': `${header}test.describe('group', () => {\n  test.afterEach(async ({ workspace, ...rest }) => void [workspace, rest]);\n  test('one', () => {});\n});\n` })).toMatch(
      /^tests\/a\.e2e\.ts:4: afterEach hook takes the rest property "\.\.\.rest"/,
    );
    expect(collectionError({ 'tests/a.e2e.ts': `${header}test('one', () => {});\n\ntest('typo', async ({ workspce }) => void workspce);\n` })).toMatch(
      /^tests\/a\.e2e\.ts:5: test "typo" names "workspce": target "fake" has no "workspce" fixture; available: agent, app, gadget, platform, screen, session, workspace \(engine fake contributes gadget\); did you mean "workspace"\?$/,
    );
    expect(collectionError({ 'tests/a.e2e.ts': `${header}test.beforeAll(({ platform }) => void platform);\n\ntest.beforeAll(({ gadget }) => void gadget);\ntest('one', () => {});\n` })).toMatch(
      /^tests\/a\.e2e\.ts:5: beforeAll hook names "gadget", a test fixture on target "fake"/,
    );
    // Declared in a module the test file imports: the error points there.
    const cyclic = `import { test as base } from 'e2e';\n\nexport const test = base.extend({\n  a: async ({ b }, use) => use(b),\n  b: async ({ a }, use) => use(a),\n});\n`;
    expect(collectionError({ 'tests/cyclic.ts': cyclic, 'tests/a.e2e.ts': `import { test } from './cyclic.ts';\ntest('one', () => {});\n` })).toMatch(
      /^tests\/cyclic\.ts:3: fixtures depend on each other in a cycle: "a" -> "b" -> "a"/,
    );
    const late = `import { test as base } from 'e2e';\n\nexport const test = base\n  .extend({\n    early: async ({ gadget, nope }, use) => use(String(gadget) + String(nope)),\n  });\n`;
    expect(collectionError({ 'tests/late.ts': late, 'tests/a.e2e.ts': `import { test } from './late.ts';\ntest('unused is fine', () => {});\ntest('one', ({ early }) => void early);\n` })).toMatch(
      /^tests\/late\.ts:\d: fixture "early" names "nope": target "fake" has no "nope" fixture/,
    );
  });

  it('lists a file whose fixture names a target does not have while no test there uses it', () => {
    const late = `import { test as base } from 'e2e';\n\nexport const test = base.extend({\n  early: async ({ nope }, use) => use(String(nope)),\n});\n`;
    const listed = cli(
      { 'e2e.config.ts': fakeConfig(), 'tests/late.ts': late, 'tests/a.e2e.ts': `import { test } from './late.ts';\ntest('unused is fine', () => {});\ntest('elsewhere', { platforms: ['other'] }, ({ early }) => void early);\n` },
      ['list'],
    );
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain('unused is fine');
  });
});
