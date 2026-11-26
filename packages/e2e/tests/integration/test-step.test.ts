/**
 * `test.step()` in a real run: the report nests the calls a step made under
 * it, a failed call fails the steps around it, and a hook's step is a step
 * of the test like any other.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';

test.beforeEach(async ({ app }) => {
  await test.step('Open the app', async () => {
    await app.open();
  });
});

test('reads the heading', async ({ screen }) => {
  const text = await test.step('Read the heading', async () => {
    return test.step('Find it', async () => {
      await screen.getByRole('heading').first().waitFor();
      return 'found';
    });
  });
  if (text !== 'found') throw new Error('the step did not return what its body did');
});

test('taps a missing button', async ({ screen }) => {
  await test.step('Log in as test user', async () => {
    await screen.getByRole('button', 'No such button').tap({ timeout: 200 });
  });
});

test('skips from inside a step', async ({ platform }) => {
  await test.step('Check the platform', async () => {
    test.skip(platform === 'web', 'not on web');
  });
});

test('hangs in a step', { timeout: 1500 }, async () => {
  await test.step('Wait for nothing', () => new Promise(() => {}));
});

test.beforeAll(async () => {
  if ((await test.step('Seed', () => 'seeded')) !== 'seeded') throw new Error('the body did not run');
});
`;

describe('test.step in a run', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject({ 'tests/step.e2e.ts': SUITE }, { appUrl: app.url }));
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const steps = (title: string) =>
    resultByTitle(outcome, title).attempts[0]!.steps.map((step) => [step.index, step.kind, step.api, step.label === '' ? '' : step.kind === 'step' ? step.label : '...', step.parent, step.phase, step.status]);

  it('records each step with the calls inside it as its children, in a report the schema takes', () => {
    const result = resultByTitle(outcome, 'reads the heading');
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
    assertValidReport(outcome.report);
    expect(steps('reads the heading')).toEqual([
      [0, 'step', 'test.step', 'Open the app', undefined, 'beforeEach', 'passed'],
      [1, 'app', 'app.open', '...', 0, 'beforeEach', 'passed'],
      [2, 'step', 'test.step', 'Read the heading', undefined, undefined, 'passed'],
      [3, 'step', 'test.step', 'Find it', 2, undefined, 'passed'],
      [4, 'locator', 'locator.waitFor', '...', 3, undefined, 'passed'],
    ]);
  });

  it('passes a step the test skipped itself from', () => {
    const result = resultByTitle(outcome, 'skips from inside a step');
    expect(result.status).toBe('skipped');
    const group = result.attempts[0]!.steps.find((step) => step.label === 'Check the platform')!;
    expect(group).toMatchObject({ kind: 'step', status: 'passed' });
    expect(group.error).toBeUndefined();
  });

  it('ends a step the test timed out in, as not passed', () => {
    const result = resultByTitle(outcome, 'hangs in a step');
    expect(result.status).toBe('timed-out');
    const group = result.attempts[0]!.steps.find((step) => step.label === 'Wait for nothing')!;
    expect(group.status).not.toBe('passed');
    assertValidReport(outcome.report);
  });

  it('fails the step with the call that failed in it, and leaves the error to that call', () => {
    const result = resultByTitle(outcome, 'taps a missing button');
    expect(result.status).toBe('failed');
    const attempt = result.attempts[0]!;
    expect(attempt.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    const group = attempt.steps.find((step) => step.label === 'Log in as test user')!;
    const tap = attempt.steps.find((step) => step.api === 'locator.tap')!;
    expect(group).toMatchObject({ kind: 'step', status: 'failed' });
    expect(group.error).toBeUndefined();
    expect(tap).toMatchObject({ parent: group.index, status: 'failed', error: { code: 'LOCATOR_NOT_FOUND' } });
  });
});

const TIMEOUTS = `import { test } from '@e2e-dev/web';

test('times out in a call', { timeout: 1000 }, async ({ app, screen }) => {
  await app.open();
  await test.step('Wait for a missing button', async () => {
    await screen.getByRole('button', 'No such button').waitFor({ timeout: 60000 });
  });
});

test('times out, then steps late', { timeout: 1000 }, async ({ app }) => {
  await app.open();
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await test.step('Late', () => new Promise((resolve) => setTimeout(resolve, 200)));
});

test('runs next', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('heading').first().waitFor();
  await new Promise((resolve) => setTimeout(resolve, 2500));
});
`;

describe('test.step around a test timeout', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject({ 'tests/timeouts.e2e.ts': TIMEOUTS }, { appUrl: app.url }));
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  const steps = (title: string) => resultByTitle(outcome, title).attempts[0]!.steps.map((step) => [step.api, step.status, step.error?.code]);

  it('cuts the call running in a step as the timeout cuts any call, not as one the test did not await', () => {
    expect(resultByTitle(outcome, 'times out in a call').status).toBe('timed-out');
    expect(steps('times out in a call').slice(1)).toEqual([
      ['test.step', 'cancelled', undefined],
      ['locator.waitFor', 'cancelled', 'CANCELLED'],
    ]);
  });

  it('keeps a step a timed-out body calls later out of the test that runs then', () => {
    expect(resultByTitle(outcome, 'times out, then steps late').status).toBe('timed-out');
    const next = resultByTitle(outcome, 'runs next');
    expect(next.status, JSON.stringify(next.attempts.at(-1)?.error)).toBe('passed');
    expect(steps('runs next').map(([api]) => api)).toEqual(['app.open', 'locator.waitFor']);
  });
});
