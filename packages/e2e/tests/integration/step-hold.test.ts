/**
 * `RunOptions.hold`, the seam behind `e2e run --step`, through real
 * worker processes: which steps wait, that held time is charged to nothing,
 * and how a hold ends when its step can no longer run.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BeforeStep, HeldStep, StepHoldContext } from '../../src/run/step-hold.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import {
  resultByTitle,
  runProject,
  runProjectWithConfigFile,
  workerFakeConfigSource,
  type FixtureProject,
  type RunOutcome,
} from '../helpers/run-project.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Holds every step whose label holds `slow` for `ms`, and lets the rest through at once; records what it saw. */
function holder(ms: number): { held: HeldStep[]; beforeStep: (step: HeldStep, context: StepHoldContext) => Promise<void> } {
  const held: HeldStep[] = [];
  return {
    held,
    beforeStep: async (step) => {
      held.push(step);
      if (step.label.includes('slow')) await sleep(ms);
    },
  };
}

/** A fake engine config with one worker that logs each observation to `observed.txt`. */
const OBSERVED_CONFIG = `import { appendFileSync } from 'node:fs';
import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const engine = createFakeEngine({
  state: true,
  observe: () => appendFileSync(new URL('./observed.txt', import.meta.url), 'observe\\n'),
}).engine;

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
} satisfies E2EConfig;
`;

const TIMEOUT_MS = 800;
const HOLD_MS = 1_500;

const HELD_SUITE = `import { test, expect } from 'e2e';

test('waits past its timeout at holds and still passes', async ({ app }) => {
  await app.open('/slow-1');
  await app.open('/slow-2');
});

test('times out on the budget a hold left', async ({ app }) => {
  await app.open('/slow-3');
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});

test('holds steps started together in call order', async ({ app }) => {
  await Promise.all([app.open('/together-a'), app.open('/together-b')]);
});

test('never holds a step inside a poll read', async ({ app }) => {
  await expect.poll(async () => { await app.open('/in-poll'); return 1; }).toBe(1);
});

const tries = globalThis as { retried?: number };
test('never holds a retry', async ({ app }) => {
  await app.open('/retry');
  tries.retried = (tries.retried ?? 0) + 1;
  if (tries.retried === 1) throw new Error('first attempt fails');
});
`;

const HOOKS_SUITE = `import { test } from 'e2e';

test.setup('seeds a session', { sessions: ['seeded'] }, async ({ app, session }) => {
  await app.open('/setup');
  await session.save('seeded');
});

test.beforeEach(async ({ app }) => { await app.open('/before-each'); });
test.afterEach(async ({ app }) => { await app.open('/after-each'); });

test('holds beforeEach and body steps, never teardown', { session: 'seeded' }, async ({ app }) => {
  await app.open('/body');
});
`;

describe('hold.ask on the worker path', () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  const { held, beforeStep } = holder(HOLD_MS);

  beforeAll(async () => {
    ({ outcome, project } = await runProjectWithConfigFile(
      { 'tests/held.e2e.ts': HELD_SUITE, 'tests/hooks.e2e.ts': HOOKS_SUITE },
      { configSource: workerFakeConfigSource(1, `\n  timeout: ${TIMEOUT_MS},\n  retries: 1,`), runOptions: { hold: { ask: beforeStep, steps: true } } },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  const labels = (): string[] => held.map((step) => step.label);

  it('stops the test clock while a step is held, and keeps the wait out of the step', () => {
    const result = resultByTitle(outcome, 'waits past its timeout at holds and still passes');
    expect(result.status).toBe('passed');
    const steps = result.attempts[0]?.steps ?? [];
    expect(steps.map((step) => step.label)).toEqual(['/slow-1', '/slow-2']);
    for (const step of steps) expect(step.durationMs).toBeLessThan(HOLD_MS);
  });

  it('times a test out on the budget it had left when the hold ended', () => {
    const result = resultByTitle(outcome, 'times out on the budget a hold left');
    expect(result.status).toBe('timed-out');
    const duration = result.attempts[0]?.durationMs ?? 0;
    expect(duration).toBeGreaterThanOrEqual(HOLD_MS + TIMEOUT_MS - 100);
    expect(duration).toBeLessThan(5_000);
  });

  it('holds steps started together one at a time and records them in call order', () => {
    expect(labels().filter((label) => label.startsWith('/together'))).toEqual(['/together-a', '/together-b']);
    const steps = resultByTitle(outcome, 'holds steps started together in call order').attempts[0]?.steps ?? [];
    expect(steps.map((step) => [step.index, step.label])).toEqual([[0, '/together-a'], [1, '/together-b']]);
  });

  it('never holds a step an expect.poll read calls', () => {
    expect(resultByTitle(outcome, 'never holds a step inside a poll read').status).toBe('passed');
    expect(labels()).not.toContain('/in-poll');
  });

  it('holds the first attempt only, never a retry', () => {
    expect(resultByTitle(outcome, 'never holds a retry').status).toBe('flaky');
    expect(labels().filter((label) => label === '/retry')).toHaveLength(1);
  });

  it('holds beforeEach and body steps, never a setup test or teardown', () => {
    expect(resultByTitle(outcome, 'holds beforeEach and body steps, never teardown').status).toBe('passed');
    expect(labels()).toEqual(expect.arrayContaining(['/before-each', '/body']));
    expect(labels()).not.toContain('/setup');
    expect(labels()).not.toContain('/after-each');
  });

  it('names the test each held step belongs to', () => {
    expect(held.find((step) => step.label === '/body')).toMatchObject({
      target: 'fake',
      title: 'holds beforeEach and body steps, never teardown',
      api: 'app.open',
      source: { file: 'tests/hooks.e2e.ts' },
    });
  });
});

describe('reading the held screen', () => {
  const suite = `import { test } from 'e2e';\ntest('reads one screen', async ({ app }) => { await app.open('/first'); await app.open('/second'); });\n`;

  /** Returns a hook that saves the screen at the `/second` step in `screens`. */
  function readAtSecond(screens: (string | undefined)[]): BeforeStep {
    return async (step, { readScreen }) => {
      if (step.label === '/second') {
        screens.push(await readScreen());
      }
    };
  }

  it('reads the screen only when the hook asks for it', async () => {
    const screens: (string | undefined)[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      { 'observed.txt': '', 'tests/screen.e2e.ts': suite },
      {
        configSource: OBSERVED_CONFIG,
        runOptions: { hold: { ask: readAtSecond(screens), steps: true } },
      },
    );
    const observed = readFileSync(path.join(project.dir, 'observed.txt'), 'utf8');
    project.cleanup();

    expect(resultByTitle(outcome, 'reads one screen').status).toBe('passed');
    expect(observed).toBe('observe\n');
    expect(screens).toEqual([expect.stringContaining('button "Submit"')]);
  }, 60_000);

  it('reads the screen only when the hook asks for it in process', async () => {
    let observed = 0;
    const screens: (string | undefined)[] = [];
    const engine = createFakeEngine({
      state: true,
      observe: () => {
        observed += 1;
      },
    }).engine;

    const { outcome, project } = await runProject(
      { 'tests/screen.e2e.ts': suite },
      {
        config: { targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }] },
        runOptions: { hold: { ask: readAtSecond(screens), steps: true } },
      },
    );
    project.cleanup();

    expect(resultByTitle(outcome, 'reads one screen').status).toBe('passed');
    expect(observed).toBe(1);
    expect(screens).toEqual([expect.stringContaining('button "Submit"')]);
  }, 60_000);
});

describe('pausing on the worker path', () => {
  it('pauses a setup test and a retry with the clock stopped, without recording a step', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/paused.e2e.ts': `import { test } from 'e2e';

test.setup('seeds a session', { sessions: ['seeded'] }, async ({ screen, session }) => {
  await screen.pause();
  await session.save('seeded');
});

const tries = globalThis as { retried?: number };
test('pauses on each attempt', { session: 'seeded' }, async ({ app, screen }) => {
  await app.open('/');
  await screen.pause();
  tries.retried = (tries.retried ?? 0) + 1;
  if (tries.retried === 1) throw new Error('first attempt fails');
});
`,
      },
      {
        configSource: workerFakeConfigSource(1, `\n  timeout: ${TIMEOUT_MS},\n  retries: 1,`),
        runOptions: {
          hold: {
            ask: async (step) => {
              held.push(step);
              await sleep(HOLD_MS);
            },
            steps: false,
          },
        },
      },
    );
    project.cleanup();
    expect(resultByTitle(outcome, 'pauses on each attempt').status).toBe('flaky');
    expect(held.map((step) => [step.kind, step.title, step.source?.line])).toEqual([
      ['pause', 'seeds a session', 4],
      ['pause', 'pauses on each attempt', 11],
      ['pause', 'pauses on each attempt', 11],
    ]);

    const apis = outcome.report.run.results.flatMap((result) =>
      result.attempts.flatMap((attempt) => attempt.steps.map((step) => step.api)),
    );

    expect(apis).not.toContain('screen.pause');
  }, 60_000);

  it('fails only the test whose unawaited code calls screen.pause() after the body returned', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/late.e2e.ts': `import { test } from 'e2e';

test('pauses after it returned', async ({ screen }) => {
  void (async () => {
    for (let i = 0; i < 100; i++) await null;
    await screen.pause();
  })();
});

test('runs after it', async ({ app }) => { await app.open('/'); });
`,
      },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          hold: {
            ask: async (step) => {
              held.push(step);
              await sleep(HOLD_MS);
            },
            steps: false,
          },
        },
      },
    );
    project.cleanup();
    expect(resultByTitle(outcome, 'pauses after it returned').attempts[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('was called after the test body ended'),
      source: { file: 'tests/late.e2e.ts', line: 6 },
    });
    expect(resultByTitle(outcome, 'runs after it').status).toBe('passed');
    expect(held).toEqual([]);
  }, 60_000);

  it('fails only the paused test, with the error the refusing hook gives', async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/refused.e2e.ts': `import { test } from 'e2e';\ntest('meets a refusing hook', async ({ screen }) => {\n  await screen.pause();\n});\ntest('runs after it', async ({ app }) => { await app.open('/'); });\n`,
      },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: { hold: { ask: () => Promise.reject(new Error('nobody can resume it')), steps: false } },
      },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'meets a refusing hook').attempts[0];
    expect(attempt?.error).toMatchObject({ message: 'nobody can resume it', source: { file: 'tests/refused.e2e.ts', line: 3 } });
    expect(resultByTitle(outcome, 'runs after it').status).toBe('passed');
    expect(outcome.report.run.errors).toEqual([]);
  }, 60_000);

  it('pauses in fixture setup and beforeEach, and fails a pause in afterEach or a fixture teardown with INVALID_ARGUMENT', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/phases.e2e.ts': `import { test as base } from 'e2e';

const test = base.extend<{ paused: number }>({
  paused: async ({ screen }, use) => {
    await screen.pause();
    await use(1);
  },
});

test.beforeEach(async ({ screen }) => { await screen.pause(); });

test('pauses in setup', async ({ paused }) => { void paused; });

test.describe('after each', () => {
  test.afterEach(async ({ screen }) => { await screen.pause(); });
  test('fails in afterEach', async ({ paused }) => { void paused; });
});
`,
        'tests/teardown.e2e.ts': `import { test as base } from 'e2e';

const test = base.extend<{ paused: number }>({
  paused: async ({ screen }, use) => {
    await use(1);
    await screen.pause();
  },
});

test('fails in a fixture teardown', async ({ paused }) => { void paused; });
`,
      },
      {
        configSource: workerFakeConfigSource(1, `\n  timeout: ${TIMEOUT_MS},`),
        runOptions: {
          hold: {
            ask: async (step) => {
              held.push(step);
              await sleep(HOLD_MS);
            },
            steps: false,
          },
        },
      },
    );
    project.cleanup();
    expect(resultByTitle(outcome, 'pauses in setup').status).toBe('passed');

    for (const [title, line] of [['fails in afterEach', 15], ['fails in a fixture teardown', 6]] as const) {
      expect(resultByTitle(outcome, title).attempts[0]?.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('was called after the test body ended (in an afterEach hook, a fixture teardown'),
      });

      expect(resultByTitle(outcome, title).attempts[0]?.error?.source?.line).toBe(line);
    }
    expect(held.map((step) => [step.title, step.source?.file, step.source?.line])).toEqual([
      ['pauses in setup', 'tests/phases.e2e.ts', 5],
      ['pauses in setup', 'tests/phases.e2e.ts', 10],
      ['after each › fails in afterEach', 'tests/phases.e2e.ts', 5],
      ['after each › fails in afterEach', 'tests/phases.e2e.ts', 10],
    ]);
  }, 60_000);

  it('pauses each time the line runs, as on every pass of a loop', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/loop.e2e.ts': `import { test } from 'e2e';\ntest('pauses in a loop', async ({ screen }) => {\n  for (let pass = 0; pass < 3; pass++) {\n    await screen.pause();\n  }\n});\n` },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: { hold: { ask: async (step) => void held.push(step), steps: false } },
      },
    );
    project.cleanup();
    expect(resultByTitle(outcome, 'pauses in a loop').status).toBe('passed');
    expect(held.map((step) => [step.kind, step.source?.line])).toEqual([
      ['pause', 4],
      ['pause', 4],
      ['pause', 4],
    ]);
  }, 60_000);

  it('refuses a pause inside an expect.poll read, on a locator, or on a frame, without asking the hook', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/refused.e2e.ts': `import { test, expect } from 'e2e';

test('pauses in a poll read', async ({ screen }) => {
  await expect.poll(async () => {
    await screen.pause();
    return 1;
  }, { timeout: 300 }).toBe(1);
});

test('pauses on a locator', async ({ screen }) => {
  const locator = screen.getByRole('button', { name: 'Submit' }) as unknown as { pause(): Promise<void> };
  await locator.pause();
});

test('pauses on a frame', async ({ gadget }) => {
  await gadget.frame().pause();
});
`,
      },
      {
        configSource: workerFakeConfigSource(1).replace(
          'createFakeEngine({ state: true })',
          'createFakeEngine({ state: true, fixtures: true })',
        ),
        runOptions: { hold: { ask: async (step) => void held.push(step), steps: false } },
      },
    );
    project.cleanup();
    // The poll retries the failing read. Its error names the last refusal.
    expect(resultByTitle(outcome, 'pauses in a poll read').attempts[0]?.error).toMatchObject({
      code: 'ASSERTION_FAILED',
      message: expect.stringContaining('last: screen.pause() was called inside another step (an onAction hook or a project tool) or an expect.poll read'),
    });
    expect(resultByTitle(outcome, 'pauses on a locator').attempts[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: "you can't call pause() on a locator or a frame, since a pause stops the whole test; call screen.pause()",
      source: { file: 'tests/refused.e2e.ts', line: 12 },
    });
    expect(resultByTitle(outcome, 'pauses on a frame').attempts[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: "you can't call pause() on a locator or a frame, since a pause stops the whole test; call screen.pause()",
      source: { file: 'tests/refused.e2e.ts', line: 16 },
    });
    expect(held).toEqual([]);
  }, 60_000);

  it("fails a pause where it isn't allowed with INVALID_ARGUMENT, not PAUSE_UNAVAILABLE, when CI is set", async () => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/ci.e2e.ts': `import { test } from 'e2e';\ntest.afterEach(async ({ screen }) => { await screen.pause(); });\ntest('pauses in afterEach in CI', async () => {});\n` },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          env: { ...process.env, CI: '1' },
          hold: { ask: () => Promise.resolve(), steps: false },
        },
      },
    );
    project.cleanup();

    expect(resultByTitle(outcome, 'pauses in afterEach in CI').attempts[0]?.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      source: { file: 'tests/ci.e2e.ts', line: 2 },
    });
  }, 60_000);

  it('fails a pause with PAUSE_UNAVAILABLE in CI, without asking the hook', async () => {
    const held: HeldStep[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/ci.e2e.ts': `import { test } from 'e2e';\ntest('pauses in CI', async ({ screen }) => {\n  await screen.pause();\n});\n` },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          env: { ...process.env, CI: '1' },
          hold: { ask: async (step) => void held.push(step), steps: false },
        },
      },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'pauses in CI').attempts[0];
    expect(attempt?.error).toMatchObject({ code: 'PAUSE_UNAVAILABLE', source: { file: 'tests/ci.e2e.ts', line: 3 } });
    expect(held).toEqual([]);
  }, 60_000);
});

describe('holding steps and the run limits', () => {
  it('stops the time limit while a step is held', async () => {
    const { beforeStep } = holder(3_000);
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/limit.e2e.ts': `import { test } from 'e2e';\ntest('outlasts the limit only at holds', async ({ app }) => { await app.open('/slow-1'); await app.open('/slow-2'); });\n` },
      { configSource: workerFakeConfigSource(1), runOptions: { hold: { ask: beforeStep, steps: true }, maxDuration: 4_000 } },
    );
    project.cleanup();
    expect(outcome.report.run.errors).toEqual([]);
    expect(resultByTitle(outcome, 'outlasts the limit only at holds').status).toBe('passed');
  }, 60_000);

  it('kills a worker that blocks its event loop after a hold on the budget it had left, not counting the hold', async () => {
    // The watchdog pings once the timeout is spent and kills a worker that
    // has not answered after at least 5 s. Counting from the release, that
    // is no sooner than hold + timeout + 5 s; counting the hold, 3 s sooner.
    const hold = 3_000;
    const timeout = 6_000;
    const { beforeStep } = holder(hold);
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/block.e2e.ts': `import { test } from 'e2e';\ntest('blocks after a hold', async ({ app }) => { await app.open('/slow'); const end = Date.now() + 60_000; while (Date.now() < end) {} });\n` },
      { configSource: workerFakeConfigSource(1, `\n  timeout: ${timeout},\n  cleanupTimeout: 500,`), runOptions: { hold: { ask: beforeStep, steps: true } } },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'blocks after a hold').attempts[0];
    expect(attempt?.status).toBe('timed-out');
    expect(attempt?.error?.message).toContain(`past its ${timeout} ms timeout`);
    expect(attempt?.durationMs).toBeGreaterThanOrEqual(hold + timeout + 4_500);
  }, 90_000);
});

describe('hold.ask ending a hold', () => {
  it('fails a held step the body never awaited, and lets its hold go', async () => {
    const signals: AbortSignal[] = [];
    // The call sits in an async helper, whose own rejection must not reach the worker as a second error.
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/unawaited.e2e.ts': `import { test } from 'e2e';\ntest('forgets to await', async ({ app }) => { void (async () => { await app.open('/never'); })(); });\n` },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          hold: {
            ask: (_step, { signal }) => {
              signals.push(signal);
              return new Promise<void>(() => undefined);
            },
            steps: true,
          },
        },
      },
    );
    project.cleanup();
    const attempt = resultByTitle(outcome, 'forgets to await').attempts[0];
    expect(attempt?.error?.code).toBe('STEP_NOT_AWAITED');
    expect(attempt?.steps).toMatchObject([{ api: 'app.open', label: '/never', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } }]);
    expect(attempt?.secondaryErrors).toEqual([]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  }, 60_000);

  it.each([
    ['rejects', () => Promise.reject(new Error('the prompt broke'))],
    ['throws', () => { throw new Error('the prompt broke'); }],
  ])('stops the run with the error a hook that %s gives, not as interrupted', async (_, beforeStep: () => Promise<void>) => {
    const { outcome, project } = await runProjectWithConfigFile(
      { 'tests/broken.e2e.ts': `import { test } from 'e2e';\ntest('meets a broken hook', async ({ app }) => { await app.open('/'); });\n` },
      { configSource: workerFakeConfigSource(1), runOptions: { hold: { ask: beforeStep, steps: true } } },
    );
    project.cleanup();
    expect(outcome.report.run.errors.map((error) => error.message)).toContain('the prompt broke');
    expect(outcome.exitCode).not.toBe(130);
    expect(outcome.exitCode).not.toBe(0);
  }, 60_000);

  it('ends a held step as interrupted when the run is interrupted', async () => {
    const interrupt = new AbortController();
    const signals: AbortSignal[] = [];
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/stop.e2e.ts': `import { test } from 'e2e';\ntest('is stopped while held', async ({ app }) => { await app.open('/held'); });\ntest('never starts', async ({ app }) => { await app.open('/'); });\n`,
      },
      {
        configSource: workerFakeConfigSource(1),
        runOptions: {
          interruptSignal: interrupt.signal,
          hold: {
            ask: (_step, { signal }) => {
              signals.push(signal);
              interrupt.abort();
              return new Promise<void>(() => undefined);
            },
            steps: true,
          },
        },
      },
    );
    project.cleanup();
    expect(outcome.exitCode).toBe(130);
    expect(resultByTitle(outcome, 'is stopped while held').status).toBe('interrupted');
    expect(resultByTitle(outcome, 'never starts').status).toBe('skipped');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }, 60_000);

  it('refuses the json reporter, whose stdout the prompt would break', async () => {
    // Not quiet: a quiet run runs no reporter that claims stdout, so nothing would break.
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/any.e2e.ts': `import { test } from 'e2e';\ntest('never runs', async () => {});\n` },
        { configSource: workerFakeConfigSource(1, `\n  reporters: ['json'],`), runOptions: { hold: { ask: () => Promise.resolve(), steps: true }, quiet: false } },
      );
      project.cleanup();
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors[0]).toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('--step cannot run with the reporter "json"') });
    } finally {
      stdout.mockRestore();
    }
  }, 60_000);
  it('prints the prompt itself while the step waits once the reporter showing it rejects', async () => {
    const stderr: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (stderr.push(String(chunk)), true));
    const reporter = `{ name: 'broken-prompt', printsTo: 'stdout', async onStepPrompt() { throw new Error('PROMPT_BOOM'); } }`;
    let shownWhileHeld = false;
    try {
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/held.e2e.ts': `import { test } from 'e2e';\ntest('waits', async ({ app }) => { await app.open('/held'); });\n` },
        {
          configSource: workerFakeConfigSource(1, `\n  reporters: [${reporter}],`),
          runOptions: {
            hold: {
              steps: true,
              ask: async (step, { show }) => {
                show({ steps: [{ step, number: 1 }], help: false, holdSteps: true });
                await sleep(200);
                shownWhileHeld = stderr.some((text) => text.startsWith('paused at step 1 of waits'));
                show(undefined);
              },
            },
          },
        },
      );
      project.cleanup();
      expect(outcome.exitCode).toBe(0);
    } finally {
      write.mockRestore();
    }
    expect(stderr.filter((text) => text.includes('threw in onStepPrompt: PROMPT_BOOM'))).toHaveLength(1);
    expect(shownWhileHeld).toBe(true);
  }, 60_000);
});
