import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import {
  resultByTitle,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const BODY_SUITE = `import { test, expect } from 'e2e';

const counters = globalThis as { abandonedReads?: number };

test('an unawaited poll fails the body that started it', async () => {
  expect
    .poll(() => {
      counters.abandonedReads = (counters.abandonedReads ?? 0) + 1;
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
});

test('a body error stays primary with the unawaited poll beside it', async () => {
  expect.poll(() => false, { timeout: 200 }).toBe(true);
  throw new Error('the body gave up');
});

test('an awaited failing poll fails with its own error', async () => {
  await expect.poll(() => false, { timeout: 100 }).toBe(true);
});

test('an awaited passing poll passes', async () => {
  let reads = 0;
  await expect.poll(() => ++reads, { intervals: [10] }).toBeGreaterThan(3);
});

test('the poll deadline cuts a running step', async ({ screen }) => {
  await expect.poll(async () => {
    await expect(screen.getByRole('button', 'Submit')).toHaveCount(2, { timeout: 0 });
    return true;
  }, { timeout: 200 }).toBe(true);
});

test('the test after them is never charged, and the abandoned poll read no more', async () => {
  const before = counters.abandonedReads;
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(counters.abandonedReads).toBe(before);
});
`;

const HOOKS_SUITE = `import { test, expect } from 'e2e';

test.describe('afterEach', () => {
  test.afterEach(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('owns the afterEach poll', async () => {});
});

test.describe('beforeEach', () => {
  test.beforeEach(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('owns the beforeEach poll', async () => {});
});

test.describe('afterAll', () => {
  test.afterAll(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('runs before the afterAll poll', async () => {});
});

test('the test after the hooks is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});
`;

/** One file per fixture, so each file's results tell one teardown's story. */
const LEAKY_FIXTURE_SUITE = `import { test as base, expect } from 'e2e';

const test = base.extend<{ leaky: number }>({
  leaky: async ({}, use) => {
    await use(1);
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  },
});

test('owns the fixture teardown poll', async ({ leaky }) => {
  expect(leaky).toBe(1);
});
`;

const TIDY_FIXTURE_SUITE = `import { test as base, expect } from 'e2e';

const test = base.extend<{ tidy: number }>({
  tidy: async ({}, use) => {
    await use(1);
    await expect.poll(() => true, { timeout: 200 }).toBe(true);
  },
});

test('an awaited poll in a fixture teardown passes', async ({ tidy }) => {
  expect(tidy).toBe(1);
});
`;

const BEFORE_ALL_SUITE = `import { test, expect } from 'e2e';

test.describe('beforeAll', () => {
  test.beforeAll(async () => {
    expect.poll(() => false, { timeout: 200 }).toBe(true);
  });
  test('sits under the beforeAll poll', async () => {});
});

test('the test after the beforeAll is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
});
`;

/** A body the timeout cut keeps running; the poll it starts later is its own, never the next test's. */
const TIMED_OUT_SUITE = `import { test, expect } from 'e2e';

test('times out, then polls from its leftover body', { timeout: 300 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  await expect.poll(() => false, { timeout: 500 }).toBe(true);
});

test('runs while the leftover body polls, and is never charged', async () => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
});
`;

const STEPS_SUITE = `import { test } from 'e2e';

test('a step call without await', async ({ app }) => {
  app.open();
});

test('a step call without await before the body throws', async ({ app }) => {
  app.open();
  throw new Error('the body gave up');
});
`;

const PASS_SUITE = `import { test, expect } from 'e2e';

test('an unawaited toPass fails the body that started it', async () => {
  expect(() => new Promise(() => {})).toPass();
});

test('the toPass deadline cuts a running step', async ({ screen }) => {
  await expect(async () => {
    await expect(screen.getByRole('button', 'Submit')).toHaveCount(2, { timeout: 0 });
  }).toPass({ timeout: 200 });
});

test('soft toPass failures allow the body to finish', async ({ app }) => {
  await expect.soft(() => expect(false).toBe(true), 'positive check').toPass({ timeout: 50 });
  await expect.soft(() => {}, 'negated check').not.toPass({ timeout: 50 });
  await app.open();
});

test('skips from toPass', async ({ screen }) => {
  await expect(() => {
    expect(screen.getByRole('button', 'Submit')).toHaveCount(2, { timeout: 0 });
    test.skip('skipped from toPass');
  }).toPass({ timeout: 200 });
});

test('skips from a late toPass try', async () => {
  await expect(async () => {
    const until = performance.now() + 80;
    while (performance.now() < until) {}
    test.skip('late skip');
  }).toPass({ timeout: 20 });
});

test('skips from negated toPass', async () => {
  await expect(() => test.skip('skipped from negated toPass')).not.toPass({ timeout: 200 });
});

test('skips from soft toPass', async () => {
  await expect.soft(() => test.skip('skipped from soft toPass')).toPass({ timeout: 200 });
});

test('skips from a poll read', async () => {
  await expect.poll(() => test.skip('skipped from a poll read'), { timeout: 200 }).toBeUndefined();
});

test('marks a toPass test fixme', async () => {
  await expect(() => test.fixme('not ready')).toPass({ timeout: 200 });
});

test('toPass continues past the original test deadline', { timeout: 200 }, async () => {
  const started = Date.now();
  let tries = 0;
  await expect(() => {
    if (++tries === 1) test.setTimeout(2000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  }).toPass();
});

test('toPass stops at an earlier test deadline', { timeout: 2000 }, async () => {
  await expect(() => {
    test.setTimeout(150);
    throw new Error('not ready at the shorter deadline');
  }).toPass({ timeout: 1000, intervals: [500] });
});

test('toPass without a timeout ends at the test deadline', { timeout: 300 }, async () => {
  await expect(() => new Promise(() => {})).toPass();
});

test('the test deadline keeps the last failed toPass try', { timeout: 300 }, async () => {
  await expect(() => { throw new Error('job still running'); }).toPass();
});

test('the test deadline keeps the last failed poll read', { timeout: 300 }, async () => {
  await expect.poll(() => 'running', { timeout: 500 }).toBe('done');
});

test('a later try passes after a failed try cancels its pending assertion', async ({ screen }) => {
  let tries = 0;
  const submit = screen.getByRole('button', 'Submit');
  await expect(async () => {
    const count = ++tries === 1 ? 2 : 1;
    await Promise.all([
      expect(submit).toHaveCount(count, { timeout: 40 }),
      expect(submit).toHaveCount(count, { timeout: 0 }),
    ]);
  }).toPass({ timeout: 2000, intervals: [10] });
});

test('a cut try can leave unawaited steps without failing the body', async ({ screen, app }) => {
  const result = await expect(async () => {
    expect(screen.getByRole('button', 'Submit')).toHaveCount(2, { timeout: 0 });
    await new Promise((resolve) => setTimeout(resolve, 125));
    app.open('/late-unawaited');
  }).toPass({ timeout: 50 }).catch((error: unknown) => error);
  expect(result).toHaveProperty('code', 'ASSERTION_FAILED');
});

test('runs while the cut try makes its unawaited call', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test('a passing try still needs to await its steps', async ({ screen }) => {
  await expect(() => {
    expect(screen.getByRole('button', 'Submit')).toHaveCount(2, { timeout: 0 });
  }).toPass({ timeout: 50 });
});

for (const kind of ['poll', 'toPass']) {
  test(kind + ' refuses navigation started after its cutoff', async ({ app }) => {
    const resume = Promise.withResolvers<void>();
    const late = Promise.withResolvers<unknown>();
    const block = async () => {
      await resume.promise;
      late.resolve(await app.open('/late-' + kind).catch((error: unknown) => error));
      return true;
    };

    const assertion = kind === 'poll'
      ? expect.poll(block, { timeout: 50 }).toBe(true)
      : expect(block).toPass({ timeout: 50 });
    expect(await assertion.catch((error: unknown) => error)).toHaveProperty('code', 'ASSERTION_FAILED');
    resume.resolve();
    expect(await late.promise).toHaveProperty('code', 'CANCELLED');
    await app.open('/live-' + kind);
  });
}
`;

const PASS_DEFAULTS_SUITE = `import { test, expect } from 'e2e';

test.beforeAll(async () => {
  const pass = await expect(() => { throw new Error('not ready'); }).toPass().catch((error: unknown) => error);
  expect(pass).toHaveProperty('message', expect.stringContaining('timed out after 200 ms'));
  const poll = await expect.poll(() => false).toBe(true).catch((error: unknown) => error);
  expect(poll).toHaveProperty('message', expect.stringContaining('timed out after 75 ms'));
});

test.afterAll(async () => {
  const pass = await expect(() => { throw new Error('not ready'); }).toPass().catch((error: unknown) => error);
  expect(pass).toHaveProperty('message', expect.stringContaining('timed out after 200 ms'));
});

test('uses the config timeout', async () => {
  await expect(() => expect(false).toBe(true)).toPass();
});

test('overrides the timeout and keeps the config intervals', async () => {
  let tries = 0;
  await expect(() => expect(++tries).toBe(2)).toPass({ timeout: 350 });
});

test('overrides the intervals', async () => {
  let tries = 0;
  await expect(() => expect(++tries).toBe(2)).toPass({ intervals: [10] });
});
`;

const HOOK_DEADLINES_SUITE = `import { test, expect } from 'e2e';

test.describe('beforeAll deadline', () => {
  test.beforeAll(async () => {
    await expect(() => new Promise(() => {})).toPass();
  });
  test('blocked by its beforeAll', async () => {});
});

test.describe('afterAll deadline', () => {
  test.afterAll(async () => {
    await expect(() => new Promise(() => {})).toPass();
  });
  test('passes before its afterAll', async () => {});
});
`;

const CUT_SAVE_SUITE = `import { test, expect } from 'e2e';

test.setup('a cut save leaves the declared session missing', { sessions: ['cut'] }, async ({ session }) => {
  const result = await expect(() => session.save('cut')).toPass({ timeout: 50 }).catch((error: unknown) => error);
  expect(result).toHaveProperty('code', 'ASSERTION_FAILED');
  await new Promise((resolve) => setTimeout(resolve, 250));
});
`;

const NOT_AWAITED = /returned before expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) finished; put `await` in front of every expect\.poll matcher and toPass call$/;

describe('expect.poll not awaited, in a run', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    ({ outcome, project } = await runProjectWithConfigFile(
      {
        'tests/a-body.e2e.ts': BODY_SUITE,
        'tests/b-hooks.e2e.ts': HOOKS_SUITE,
        'tests/b-leaky-fixture.e2e.ts': LEAKY_FIXTURE_SUITE,
        'tests/b-tidy-fixture.e2e.ts': TIDY_FIXTURE_SUITE,
        'tests/c-before-all.e2e.ts': BEFORE_ALL_SUITE,
        'tests/d-timed-out.e2e.ts': TIMED_OUT_SUITE,
        'tests/e-steps.e2e.ts': STEPS_SUITE,
        'tests/f-to-pass.e2e.ts': PASS_SUITE,
        'tests/g-cut-save.setup.e2e.ts': CUT_SAVE_SUITE,
        'tests/g-uses-cut.e2e.ts': "import { test } from 'e2e';\ntest('needs the cut session', { session: 'cut' }, async () => {});",
      },
      { configSource: `import { appendFileSync } from 'node:fs';\n${workerFakeConfigSource(1).replace(
        '{ state: true }',
        `{ state: true, onCapture: () => new Promise((resolve) => setTimeout(resolve, 150)), onNavigate(url) { appendFileSync(new URL('./navigations.txt', import.meta.url), url + '\\n'); } }`,
      )}` },
    ));
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
  });

  it('produces a schema-valid report and fails the run', () => {
    assertValidReport(outcome.report);
    expect(outcome.exitCode).toBe(1);
  });

  it('fails the body that returned before its poll finished, at the line of the call', () => {
    const attempt = resultByTitle(outcome, 'an unawaited poll fails the body that started it').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });
    expect(attempt.error?.message).toMatch(/^the test body /);
    expect(attempt.error?.message).toMatch(NOT_AWAITED);
    expect(attempt.error?.source?.file).toBe('tests/a-body.e2e.ts');
    // A poll is not a step: nothing is recorded for it.
    expect(attempt.steps).toEqual([]);
    expect(attempt.secondaryErrors).toEqual([]);
  });

  it('keeps the body error primary and notes the unawaited poll beside it', () => {
    const attempt = resultByTitle(outcome, 'a body error stays primary with the unawaited poll beside it').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors.map((error) => [error.code, error.phase])).toEqual([['STEP_NOT_AWAITED', 'body']]);
  });

  it('fails a body that returns before a step it started finished with STEP_NOT_AWAITED', () => {
    const attempt = resultByTitle(outcome, 'a step call without await').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });
    expect(attempt.error?.message).toContain('app.open');
    expect(attempt.error?.source?.file).toBe('tests/e-steps.e2e.ts');
    expect(attempt.steps).toHaveLength(1);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('keeps the body error primary and notes the un-awaited step beside it', () => {
    const attempt = resultByTitle(outcome, 'a step call without await before the body throws').attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'ERROR', message: 'the body gave up' });
    expect(attempt.secondaryErrors.map((error) => error.code)).toEqual(['STEP_NOT_AWAITED']);
    expect(attempt.steps[0]).toMatchObject({ api: 'app.open', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('leaves awaited polls alone', () => {
    const failing = resultByTitle(outcome, 'an awaited failing poll fails with its own error').attempts[0]!;
    expect(failing.error?.code).toBe('ASSERTION_FAILED');
    expect(failing.error?.message).toMatch(/^expect\.poll\(\.\.\.\)\.toBe\(\.\.\.\) timed out after 100 ms/);
    expect(resultByTitle(outcome, 'an awaited passing poll passes').status).toBe('passed');
    expect(resultByTitle(outcome, 'an awaited poll in a fixture teardown passes').status).toBe('passed');
  });

  it('cancels the abandoned polls: no later test is charged with their timeouts', () => {
    for (const title of [
      'the test after them is never charged, and the abandoned poll read no more',
      'the test after the hooks is never charged',
      'the test after the beforeAll is never charged',
      'runs while the leftover body polls, and is never charged',
    ]) {
      expect(resultByTitle(outcome, title).status, title).toBe('passed');
    }
  });

  it('keeps a timed-out body to its own timeout', () => {
    const attempt = resultByTitle(outcome, 'times out, then polls from its leftover body').attempts[0]!;
    expect(attempt.error?.code).toBe('TEST_TIMEOUT');
    expect(attempt.secondaryErrors).toEqual([]);
  });

  it('fails the test whose afterEach, beforeEach, or fixture teardown left a poll running', () => {
    const afterEach = resultByTitle(outcome, 'owns the afterEach poll').attempts[0]!;
    expect(afterEach.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'afterEach' });
    expect(afterEach.error?.message).toMatch(/^the afterEach hook /);
    expect(afterEach.error?.message).toMatch(NOT_AWAITED);
    expect(afterEach.error?.source?.file).toBe('tests/b-hooks.e2e.ts');

    const beforeEach = resultByTitle(outcome, 'owns the beforeEach poll').attempts[0]!;
    expect(beforeEach.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'body' });

    const teardown = resultByTitle(outcome, 'owns the fixture teardown poll').attempts[0]!;
    expect(teardown.error).toMatchObject({ code: 'STEP_NOT_AWAITED', phase: 'afterEach' });
    expect(teardown.error?.message).toMatch(/^the fixture "leaky" teardown /);
  });

  it('fails a suite hook that left a poll running as that hook, never as an unhandled rejection', () => {
    expect(resultByTitle(outcome, 'runs before the afterAll poll').status).toBe('passed');
    const errors = outcome.report.run.errors;
    expect(errors.map((error) => [error.code, error.phase])).toEqual([
      ['HOOK_FAILED', 'afterAll'],
      ['HOOK_FAILED', 'beforeAll'],
    ]);
    expect(errors[0]?.message).toMatch(/^afterAll failed: the afterAll hook /);
    expect(errors[1]?.message).toMatch(/^beforeAll failed: the beforeAll hook /);
    for (const error of errors) expect(error.message).toMatch(NOT_AWAITED);
    expect(resultByTitle(outcome, 'sits under the beforeAll poll').status).not.toBe('passed');
  });

  it('fails the attempt at an unawaited toPass call', () => {
    const attempt = resultByTitle(outcome, 'an unawaited toPass fails the body that started it').attempts[0];
    expect(attempt?.error).toMatchObject({
      code: 'STEP_NOT_AWAITED',
      message: expect.stringContaining('the test body returned before expect(...).toPass() finished'),
      source: { file: 'tests/f-to-pass.e2e.ts' },
    });
    expect(attempt?.secondaryErrors).toEqual([]);
  });

  it.each([
    ['toPass', 'expect(...).toPass() timed out after 200 ms\nlast: no try completed'],
    ['poll', 'expect.poll(...).toBe(...) timed out after 200 ms\nlast: no read completed'],
  ])('reports one assertion failure when the %s deadline cuts a pending step', (kind, message) => {
    const attempt = resultByTitle(outcome, `the ${kind} deadline cuts a running step`).attempts[0];
    expect(attempt?.error).toMatchObject({ code: 'ASSERTION_FAILED', message });
    expect(attempt?.steps).toMatchObject([{ status: 'cancelled' }]);
    expect(attempt?.secondaryErrors).toEqual([]);
  });

  it.each(['poll', 'toPass'])('refuses a %s step started after its cutoff before it can navigate', (kind) => {
    const result = resultByTitle(outcome, `${kind} refuses navigation started after its cutoff`);
    expect(result.status).toBe('passed');
    expect(result.attempts[0]?.steps).toMatchObject([{ api: 'app.open', status: 'passed' }]);
    const navigations = readFileSync(path.join(project.dir, 'navigations.txt'), 'utf8');
    expect(navigations).toContain(`/live-${kind}\n`);
    expect(navigations).not.toContain(`/late-${kind}`);
  });

  it('keeps both soft toPass failures and reports them after later steps finish', () => {
    const attempt = resultByTitle(outcome, 'soft toPass failures allow the body to finish').attempts[0];
    expect(attempt?.error).toMatchObject({ code: 'ASSERTION_FAILED' });
    expect(attempt?.error?.message).toContain('2 soft assertions failed');
    expect(attempt?.error?.message).toContain('expect(...).toPass() timed out after 50 ms\n   positive check');
    expect(attempt?.error?.message).toContain('expect(...).not.toPass() timed out after 50 ms\n   negated check');
    expect(attempt?.steps).toMatchObject([{ api: 'app.open', status: 'passed' }]);
  });

  it('ends a toPass without its own timeout at the test deadline', () => {
    const attempt = resultByTitle(outcome, 'toPass without a timeout ends at the test deadline').attempts[0];
    expect(attempt?.error).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 300 ms') });
    expect(attempt?.secondaryErrors).toEqual([]);
  });

  it.each([
    ['skips from toPass', 'explicit', 'skipped from toPass'],
    ['skips from a late toPass try', 'explicit', 'late skip'],
    ['skips from negated toPass', 'explicit', 'skipped from negated toPass'],
    ['skips from soft toPass', 'explicit', 'skipped from soft toPass'],
    ['skips from a poll read', 'explicit', 'skipped from a poll read'],
    ['marks a toPass test fixme', 'fixme', 'fixme: not ready'],
  ])('preserves the skip verdict when a test %s', (title, cause, reason) => {
    const result = resultByTitle(outcome, title);
    expect(result.status).toBe('skipped');
    expect(result.skip).toEqual({ cause, reason });
    if (title === 'skips from toPass') {
      expect(result.attempts[0]?.steps).toMatchObject([{ status: 'cancelled' }]);
    }
  });

  it('passes when toPass continues past the original test deadline', () => {
    const result = resultByTitle(outcome, 'toPass continues past the original test deadline');
    expect(result.attempts[0]?.status).toBe('passed');
  });

  it('reports the earlier test deadline and keeps the last failed try', () => {
    const attempt = resultByTitle(outcome, 'toPass stops at an earlier test deadline').attempts[0];
    expect(attempt?.error).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 150 ms') });
    expect(attempt?.secondaryErrors).toMatchObject([{
      code: 'ASSERTION_FAILED',
      message: expect.stringMatching(/stopped at the attempt deadline after \d+ ms\nlast: not ready at the shorter deadline$/),
    }]);
  });

  it.each([
    ['the test deadline keeps the last failed toPass try', 'last: job still running'],
    ['the test deadline keeps the last failed poll read', 'last: expected "running" to be "done"'],
  ])('reports TEST_TIMEOUT and the last assertion failure for %s', (title, last) => {
    const attempt = resultByTitle(outcome, title).attempts[0];
    expect(attempt?.error?.code).toBe('TEST_TIMEOUT');
    expect(attempt?.secondaryErrors).toMatchObject([{ code: 'ASSERTION_FAILED', phase: 'body', message: expect.stringContaining(last) }]);
  });

  it('passes after a failed try cancels its pending assertion', () => {
    const result = resultByTitle(outcome, 'a later try passes after a failed try cancels its pending assertion');
    expect(result.status).toBe('passed');
    expect(result.attempts[0]?.steps.map((step) => step.status)).toEqual(['failed', 'cancelled', 'passed', 'passed']);
    expect(result.attempts[0]?.secondaryErrors).toEqual([]);
  });

  it('does not charge unawaited steps from a cut try to either test', () => {
    for (const title of ['a cut try can leave unawaited steps without failing the body', 'runs while the cut try makes its unawaited call']) {
      const result = resultByTitle(outcome, title);
      expect(result.status, title).toBe('passed');
      expect(result.attempts[0]?.secondaryErrors).toEqual([]);
    }
    expect(outcome.report.run.errors.map((error) => error.code)).not.toContain('UNHANDLED_REJECTION');
  });

  it('reports an unawaited step from a passing try', () => {
    expect(resultByTitle(outcome, 'a passing try still needs to await its steps').attempts[0]?.error?.code).toBe('STEP_NOT_AWAITED');
  });

  it('leaves a session unsaved when its save step is cut', () => {
    const attempt = resultByTitle(outcome, 'a cut save leaves the declared session missing').attempts[0];
    expect(attempt?.steps).toMatchObject([{ api: 'session.save', status: 'cancelled' }]);
    expect(attempt?.error).toMatchObject({ code: 'SESSION_CONTRACT', message: expect.stringContaining('missing: [cut]') });
  });
});

describe('toPass defaults in a project', () => {
  it('lets a beforeAll poll read finish past the original hook deadline', async () => {
    const suite = `import { test, expect } from 'e2e';
test.beforeAll(async () => {
  let reads = 0;
  await expect.poll(async () => {
    await Promise.resolve();
    if (++reads === 1) test.setTimeout(2000);
    await new Promise((resolve) => setTimeout(resolve, 280));
    return true;
  }).toBe(true);
  expect(reads).toBe(1);
});
test('runs after the extended hook', async () => {});
`;
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/extended-hook.e2e.ts': suite },
      { configSource: workerFakeConfigSource(1, '\n  timeout: 200,') },
    );
    try {
      expect(outcome.report.run.errors).toEqual([]);
      expect(resultByTitle(outcome, 'runs after the extended hook').status).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it('reads the config and applies call overrides independently', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/to-pass-defaults.e2e.ts': PASS_DEFAULTS_SUITE },
      { configSource: workerFakeConfigSource(1, '\n  assertionTimeout: 75, toPass: { timeout: 200, intervals: [5000] },') },
    );
    try {
      expect(resultByTitle(outcome, 'uses the config timeout').attempts[0]?.error).toMatchObject({
        code: 'ASSERTION_FAILED',
        message: expect.stringContaining('timed out after 200 ms'),
      });
      expect(resultByTitle(outcome, 'overrides the timeout and keeps the config intervals').attempts[0]?.error).toMatchObject({
        code: 'ASSERTION_FAILED',
        message: 'expect(...).toPass() timed out after 350 ms\nlast: expected 1 to be 2',
      });
      expect(resultByTitle(outcome, 'overrides the intervals').status).toBe('passed');
      expect(outcome.report.run.errors).toEqual([]);
    } finally {
      project.cleanup();
    }
  });

  it('uses the hook deadline for toPass without a timeout in beforeAll and afterAll', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/hook-deadlines.e2e.ts': HOOK_DEADLINES_SUITE },
      { configSource: workerFakeConfigSource(1, '\n  timeout: 200, cleanupTimeout: 200,') },
    );
    try {
      expect(outcome.report.run.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'HOOK_FAILED', phase: 'beforeAll', message: 'beforeAll failed: beforeAll hook timed out' }),
        expect.objectContaining({ code: 'HOOK_FAILED', phase: 'afterAll', message: 'afterAll failed: afterAll hook timed out' }),
      ]));
      expect(resultByTitle(outcome, 'passes before its afterAll').status).toBe('passed');
    } finally {
      project.cleanup();
    }
  });

  it.each(['beforeAll', 'afterAll'] as const)('reports the last failed toPass try when %s times out', async (hook) => {
    const suite = `import { test, expect } from 'e2e';
test.${hook}(async () => {
  let tries = 0;
  await expect(async () => {
    if (++tries === 1) throw new Error('db not ready');
    await new Promise(() => {});
  }).toPass();
});
test('runs with a suite hook', async () => {});
`;
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/hook-retry-failure.e2e.ts': suite },
      { configSource: workerFakeConfigSource(1, '\n  timeout: 200, cleanupTimeout: 200,') },
    );
    try {
      expect(outcome.report.run.errors).toEqual([
        expect.objectContaining({
          code: 'HOOK_FAILED',
          phase: hook,
          message: expect.stringMatching(new RegExp(`^${hook} failed: ${hook} hook timed out\\n.*\\nlast: db not ready$`)),
        }),
      ]);
    } finally {
      project.cleanup();
    }
  });
});
