/**
 * `test.setTimeout(timeout)` through the real runner: from a body or a
 * `beforeEach` hook it replaces the attempt's test timeout, counted from the
 * attempt's start, in either direction; from a `beforeAll` hook it replaces
 * that hook's timeout, the device calls it makes included; `afterEach` and
 * `afterAll` hooks, worker fixture teardowns, a bad value, and a call outside
 * a running test are refused. A test that raised its timeout still skips itself
 * as fixme after the timeout it started with.
 */

import { describe, expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, runProjectWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

const TESTS = `import { afterAll, afterEach, beforeAll, beforeEach, describe, test } from 'e2e';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('raises the timeout', { timeout: 300 }, async () => {
  test.setTimeout(10_000);
  await sleep(900);
});

test('lowers the timeout', { timeout: 30_000 }, async () => {
  test.setTimeout(300);
  await sleep(10_000);
});

test('below the time spent times out at once', { timeout: 30_000 }, async () => {
  await sleep(400);
  test.setTimeout(100);
  await sleep(10_000);
});

describe('raised from beforeEach', () => {
  beforeEach(() => {
    test.setTimeout(10_000);
  });

  test('outlasts its own timeout', { timeout: 300 }, async () => {
    await sleep(900);
  });
});

test('refuses a timeout that is not a positive integer', async () => {
  test.setTimeout(0);
});

test('refuses a fraction', async () => {
  test.setTimeout(1.5);
});

describe('from afterEach', () => {
  afterEach(() => {
    test.setTimeout(10_000);
  });

  test('is refused', async () => {});
});

describe('raised from beforeAll', () => {
  beforeAll(async () => {
    test.setTimeout(10_000);
    await sleep(900);
  });

  test('runs after a beforeAll that outlasted the config timeout', async () => {});
});

describe('lowered from beforeAll', () => {
  beforeAll(async () => {
    test.setTimeout(100);
    // Inside the config's 500 ms, so only the lowered 100 ms times it out.
    await sleep(300);
  });

  test('never runs', async () => {});
});

describe('from afterAll', () => {
  afterAll(() => {
    test.setTimeout(10_000);
  });

  test('runs before it', async () => {});
});
`;

describe('test.setTimeout', () => {
  it(
    'replaces the running attempt\'s timeout from a body or beforeEach hook, a beforeAll hook\'s own, and refuses afterEach, afterAll and bad values',
    async () => {
      // Every hook and test without its own timeout gets the config's 500 ms.
      const { outcome, project } = await runProject({ 'tests/timeouts.e2e.ts': TESTS }, { config: { timeout: 500 } });
      try {
        assertValidReport(outcome.report);
        const result = (title: string) => outcome.report.run.results.find((candidate) => candidate.titlePath.at(-1) === title)!;
        const error = (title: string) => result(title).attempts[0]?.error;

        expect(result('raises the timeout').status).toBe('passed');
        expect(result('outlasts its own timeout').status).toBe('passed');

        const lowered = result('lowers the timeout');
        expect(lowered.status).toBe('timed-out');
        expect(error('lowers the timeout')).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 300 ms in phase body') });
        // Cut at the new timeout, well before the 10 s the body waits.
        expect(lowered.attempts[0]!.durationMs).toBeLessThan(5_000);

        expect(result('below the time spent times out at once').status).toBe('timed-out');
        expect(error('below the time spent times out at once')).toMatchObject({ code: 'TEST_TIMEOUT', message: expect.stringContaining('test timed out after 100 ms') });
        expect(result('below the time spent times out at once').attempts[0]!.durationMs).toBeLessThan(5_000);

        expect(error('refuses a timeout that is not a positive integer')).toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: 'test.setTimeout() timeout must be a positive safe integer of milliseconds, got 0',
        });
        expect(error('refuses a fraction')).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('got 1.5') });
        expect(error('is refused')).toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringContaining('cannot change the timeout from an afterEach hook'),
        });

        expect(result('runs after a beforeAll that outlasted the config timeout').status).toBe('passed');
        const hookErrors = outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }));
        expect(hookErrors).toContainEqual({ code: 'HOOK_FAILED', phase: 'beforeAll', message: 'beforeAll failed: beforeAll hook timed out' });
        expect(result('never runs').status).not.toBe('passed');
        expect(result('runs before it').status).toBe('passed');
        expect(hookErrors).toContainEqual({
          code: 'HOOK_FAILED',
          phase: 'afterAll',
          message: expect.stringContaining('cannot change the timeout from an afterAll hook'),
        });
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'moves the budget of the engine attempt a beforeAll runs in, and refuses a worker fixture teardown',
    async () => {
      const file = `import { test as base, beforeAll } from 'e2e';

const test = base.extend<{}, { kept: string }>({
  kept: [async ({}, use) => {
    await use('kept');
    test.setTimeout(10_000);
  }, { scope: 'worker' }],
});

test.describe('seeds through the device', () => {
  // The click runs on the hook's attempt budget, which the raise moves past the config's 500 ms.
  beforeAll(async ({ screen }) => {
    test.setTimeout(60_000);
    await screen.getByRole('button', { name: 'Submit' }).click();
  });

  test('runs after the seeding', async ({ kept }) => {});
});
`;
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine, { timeout: 500, actionTimeout: 5_000, retries: 0 }) },
      );
      try {
        assertValidReport(outcome.report);
        expect(resultByTitle(outcome, 'runs after the seeding').status).toBe('passed');
        // The hook's engine calls got the action timeout, not the 500 ms the hook started with.
        const hookCalls = fake.operations.filter((operation) => operation.attemptIndex === 0);
        expect(hookCalls.length).toBeGreaterThan(0);
        for (const call of hookCalls) expect(call.timeoutMs, call.method).toBeGreaterThan(1_000);
        expect(outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message }))).toEqual([
          {
            code: 'INVALID_ARGUMENT',
            phase: 'cleanup',
            message: expect.stringContaining('cannot change the timeout from a worker fixture "kept" teardown'),
          },
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'tells a worker\'s watchdog the new timeout, so a body that blocks its event loop is killed past that one',
    async () => {
      // The watchdog pings once the timeout is spent and kills a worker that
      // has not answered after at least 5 s; told only the test's own 500 ms,
      // it would kill this one about 3.5 s sooner and name 500 ms.
      const raised = 4_000;
      const file = `import { test } from 'e2e';\ntest('blocks after raising', { timeout: 500 }, async () => { test.setTimeout(${raised}); const end = Date.now() + 60_000; while (Date.now() < end) {} });\n`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/block.e2e.ts': file },
        { configSource: workerFakeConfigSource(1, '\n  cleanupTimeout: 500,') },
      );
      try {
        const attempt = resultByTitle(outcome, 'blocks after raising').attempts[0];
        expect(attempt?.status).toBe('timed-out');
        expect(attempt?.error?.message).toContain(`past its ${raised} ms timeout`);
        expect(attempt?.durationMs).toBeGreaterThanOrEqual(raised + 4_500);
      } finally {
        project.cleanup();
      }
    },
    90_000,
  );

  it(
    'skips a test as fixme when it reaches test.fixme after the timeout it raised',
    async () => {
      const file = `import { test } from 'e2e';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('fixme past the first timeout', { timeout: 300 }, async () => {
  test.setTimeout(10_000);
  await sleep(900);
  test.fixme('not ready');
});
`;
      const { outcome, project } = await runProject({ 'tests/fixme.e2e.ts': file }, {});
      try {
        assertValidReport(outcome.report);
        const result = resultByTitle(outcome, 'fixme past the first timeout');
        const skip = { cause: 'fixme', reason: 'fixme: not ready' };
        expect(result).toMatchObject({ status: 'skipped', skip });
        expect(result.attempts[0]).toMatchObject({ status: 'skipped', skip });
        // The skip came after the 300 ms the test started with.
        expect(result.attempts[0]!.durationMs).toBeGreaterThanOrEqual(900);
        expect(outcome.exitCode).toBe(0);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'rejects a call outside a running test at collection',
    async () => {
      const file = `import { test } from 'e2e';

test.setTimeout(60_000);
test('never registered', async () => {});
`;
      const { outcome, project } = await runProject({ 'tests/outside.e2e.ts': file }, {});
      try {
        expect(outcome.exitCode).toBe(2);
        expect(outcome.report.run.errors.map((entry) => entry.code)).toEqual(['COLLECTION_ERROR']);
        expect(outcome.report.run.errors[0]?.message).toMatch(/must be called inside a test body or a beforeEach or beforeAll hook/);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
