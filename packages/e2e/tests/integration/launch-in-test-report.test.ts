/**
 * A test that opens a second session with `launch()` from `@e2e-dev/core`:
 * the session's steps are in the test's record, each under the session's
 * name and in the order they began, its video is among the test's
 * artifacts, and the attempt owns its end: a session the test left open, or
 * left a step running on, is closed with it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/run/events.ts';
import type { RunOutcome } from '../../src/run/runner.ts';
import { createFakeEngine, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject } from '../helpers/run-project.ts';

const SUITE = `import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'e2e';
import { launch } from '@e2e-dev/core';
import { createFakeEngine, FAKE_APP } from '../../../helpers/fake-engine.ts';

const scene = () => [{ id: 'confirm', role: 'button', name: 'Confirm' }];
const second = (extra = {}) => createFakeEngine({ video: true, scene, ...extra }).engine;
const open = (extra, options = {}) => launch(second(extra), { app: FAKE_APP, handleSignals: false, timeout: 5_000, ...options });

// Opened while no test runs; each test opens its own session on it.
const shared = await open();
// A session opened while no test runs: it visits the tests that use it, and is nobody's to close but the file's.
const visitingHost = await open();
const visiting = await visitingHost.newSession();

test('drives a second session between its own steps', async ({ app, screen }) => {
  await app.open();
  const host = await open();
  const session = await host.newSession();
  await session.app.open('/');
  await session.screen.getByRole('button', 'Confirm').tap();
  await host.close();
  await screen.getByRole('button', 'Send').tap();
});

test('opens two more sessions', async ({ app }) => {
  await app.open();
  const first = await open();
  const other = await open();
  const a = await first.newSession();
  const b = await other.newSession();
  await b.app.open('/b');
  await a.app.open('/a');
  await first.close();
  await other.close();
});

test('uses the host opened at the top of the file', async ({ app }) => {
  await app.open();
  const session = await shared.newSession();
  await session.app.open('/shared');
  await session.close();
});

test('uses it again', async ({ app }) => {
  await app.open();
  const session = await shared.newSession();
  await session.app.open('/shared-again');
  await session.close();
  await shared.close();
});

test('uses the session opened at the top of the file', async ({ app }) => {
  await app.open();
  await visiting.app.open('/visit');
});

test('uses that session again', async ({ app }) => {
  await app.open();
  await visiting.app.open('/visit-again');
  await visitingHost.close();
});

test('passes while keeping videos of failures only', { video: 'retain-on-failure' }, async ({ app }) => {
  await app.open();
  const host = await open();
  const session = await host.newSession();
  await session.app.open('/');
  await host.close();
});

test('never closes the host and session it opened', async ({ app }) => {
  await app.open();
  const left = createFakeEngine({ video: true, scene });
  globalThis.launchReportLeftOpen = left;
  const host = await launch(left.engine, { app: FAKE_APP, handleSignals: false });
  const session = await host.newSession();
  await session.app.open('/left-open');
});

test('keeps the link of a session a hosted service recorded', async ({ app }) => {
  await app.open();
  const host = await open({ videoLinks: ['https://videos.example.test/session-2'] });
  const session = await host.newSession();
  await session.app.open('/');
  await host.close();
});

test('leaves a step of the second session running', async ({ app }) => {
  await app.open();
  const host = await open();
  const session = await host.newSession();
  await session.app.open('/');
  session.screen.getByRole('button', 'Never there').waitFor();
});

test('never awaits the session it opens', async ({ app }) => {
  await app.open();
  const host = await open({ onStartAttempt: () => new Promise((resolve) => setTimeout(resolve, 300)) });
  host.newSession();
});

test('never awaits the host it launches', async ({ app }) => {
  await app.open();
  open({ onInit: () => new Promise((resolve) => setTimeout(resolve, 300)) });
});

// Each opening below is awaited and its rejection caught: the test meets the failure, so it has nothing of it left in flight.
const refusal = async (opening) => {
  try {
    await opening;
  } catch (cause) {
    return cause.code;
  }
  return 'opened';
};

test('catches a launch refused for its options', async ({ app }) => {
  await app.open();
  globalThis.launchReportRefused = { options: await refusal(launch(second(), { app: FAKE_APP, handleSignals: false, bogus: true })) };
});

test('catches a launch whose engine fails to start', async ({ app }) => {
  await app.open();
  globalThis.launchReportRefused.init = await refusal(open({ onInit: () => { throw new Error('no device left'); } }));
});

test('catches a launch whose working directory cannot be resolved', async ({ app }) => {
  await app.open();
  globalThis.launchReportRefused.cwd = await refusal(open({}, { cwd: 42 }));
});

/** Calls launch with the temporary directory at root: launch names its output directory before its first await, so the variables are back at once. */
const launchUnder = (root, launching) => {
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  Object.assign(process.env, { TMPDIR: root, TMP: root, TEMP: root });
  try {
    return launching();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

test('catches a launch whose options throw when read', async ({ app }) => {
  await app.open();
  // Handed to launch as is: spreading the options would call the getter before launch runs.
  const options = { app: FAKE_APP, handleSignals: false, get artifactsDir() { throw Object.assign(new Error('the artifact mount is missing'), { code: 'NO_MOUNT' }); } };
  globalThis.launchReportRefused.getter = await refusal(launch(second(), options));
});

test('catches a launch that cannot make its output directory', async ({ app }) => {
  await app.open();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'e2e-launch-root-'));
  try {
    globalThis.launchReportRefused.mkdtemp = await refusal(launchUnder(path.join(scratch, 'missing'), () => open()));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('catches a launch that fails to start and then to remove its output directory', async ({ app }) => {
  await app.open();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'e2e-launch-root-'));
  const root = path.join(scratch, 'temp');
  mkdirSync(root);
  try {
    // A file in place of the output directory's parent once the directory is made, so removing it fails with ENOTDIR, for root too.
    globalThis.launchReportRefused.cleanup = await refusal(launchUnder(root, () => open({ onInit: () => {
      renameSync(root, path.join(scratch, 'moved'));
      writeFileSync(root, '');
      throw Object.assign(new Error('no device left'), { code: 'NO_DEVICE' });
    } })));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('catches a session refused for its state', async ({ app }) => {
  await app.open();
  const host = await open();
  globalThis.launchReportRefused.state = await refusal(host.newSession({ state: 'not a state' }));
  await host.close();
});

test('catches a session whose engine fails to start it', async ({ app }) => {
  await app.open();
  const host = await open({ onStartAttempt: () => { throw new Error('the app crashed on launch'); } });
  globalThis.launchReportRefused.start = await refusal(host.newSession());
  await host.close();
});

test('fails a locator on the second session', async ({ app }) => {
  await app.open();
  const host = await launch(second(), { app: FAKE_APP, handleSignals: false, timeout: 200 });
  const session = await host.newSession();
  await session.app.open('/');
  await session.screen.getByRole('button', 'Send').tap();
});

// A worker fixture is set up inside the first test that names it and outlives it: what it launches is no test's to close.
const withPhone = test.extend({
  phone: [async ({}, use) => {
    const engine = createFakeEngine({ video: true, scene });
    globalThis.launchReportWorkerFixture = engine;
    const host = await launch(engine.engine, { app: FAKE_APP, handleSignals: false });
    await use(await host.newSession());
    await host.close();
  }, { scope: 'worker' }],
});

withPhone('uses the session a worker fixture opened', async ({ app, phone }) => {
  await app.open();
  await phone.app.open('/worker-first');
});

withPhone('uses that fixture again', async ({ app, phone }) => {
  await app.open();
  await phone.app.open('/worker-second');
});

describe('a timeout under the second session', () => {
  // By teardown the session's step is cut and the session closed: nothing of it goes on driving the app.
  test.afterEach(async () => {
    globalThis.launchReportInTeardown = await globalThis.launchReportTimedOut.app.open('/in-teardown').then(() => 'still open', (cause) => cause.code);
  });

  test('times out while a step of the second session waits', { timeout: 2_000, video: 'retain-on-failure' }, async ({ app }) => {
    await app.open();
    const host = await open();
    const session = await host.newSession();
    globalThis.launchReportTimedOut = session;
    await session.app.open('/');
    await session.screen.getByRole('button', 'Never there').waitFor();
  });
});

describe('a host launched in a hook', () => {
  test.beforeEach(async () => {
    const left = createFakeEngine({ video: true, scene });
    globalThis.launchReportFromHook = left;
    const host = await launch(left.engine, { app: FAKE_APP, handleSignals: false });
    globalThis.launchReportHookSession = await host.newSession();
  });

  test('uses the session its hook opened', async ({ app }) => {
    await app.open();
    await globalThis.launchReportHookSession.app.open('/from-the-hook');
  });
});

// The runner loads this file again for a retry, so the count lives on globalThis.
test('passes on its retry', { retries: 1 }, async ({ app }) => {
  await app.open();
  const tries = (globalThis.launchReportTries = (globalThis.launchReportTries ?? 0) + 1);
  const host = await open();
  const session = await host.newSession();
  await session.app.open('/try-' + tries);
  await host.close();
  if (tries === 1) throw new Error('the first try fails');
});

describe('two members of a serial group', { serial: true }, () => {
  for (const member of ['first', 'second']) {
    test('the ' + member + ' opens a session', async () => {
      const host = await open();
      const session = await host.newSession();
      await session.app.open('/' + member);
      await host.close();
    });
  }
});
`;

describe('a launch() session opened inside a test, in the test\'s report', { timeout: 120_000 }, () => {
  let outcome: RunOutcome;
  let project: FixtureProject;
  const events: RunEvent[] = [];

  beforeAll(async () => {
    const fake = createFakeEngine({ video: true, scene: () => [{ id: 'send', role: 'button', name: 'Send' }] });
    ({ outcome, project } = await runProject(
      { 'tests/two-sessions.e2e.ts': SUITE },
      {
        config: engineConfig(fake.engine, { video: 'on', trace: 'on', actionTimeout: 300, assertionTimeout: 200, cleanupTimeout: 2_000 }),
        runOptions: { onEvent: (event) => { events.push(event); } },
      },
    ));
  }, 120_000);

  afterAll(() => project?.cleanup());

  const results = () => path.join(project.dir, '.e2e', 'results');
  const attemptsOf = (title: string) => resultByTitle(outcome, title).attempts;
  const attemptOf = (title: string) => attemptsOf(title)[0]!;
  const sessionVideos = (title: string) => attemptOf(title).artifacts.filter((artifact) => artifact.kind === 'video' && artifact.actor !== undefined);

  it('records the session\'s steps with the test\'s own, under its name and in the order they began', () => {
    const attempt = attemptOf('drives a second session between its own steps');
    expect(attempt.status, JSON.stringify(attempt.error)).toBe('passed');
    expect(attempt.steps.map((step) => [step.actor, step.api, step.status])).toEqual([
      [undefined, 'app.open', 'passed'],
      ['launch-1', 'app.open', 'passed'],
      ['launch-1', 'locator.tap', 'passed'],
      [undefined, 'locator.tap', 'passed'],
    ]);
    expect(attempt.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
    expect(new Set(attempt.steps.map((step) => step.id)).size).toBe(4);
    // The session's step names the test line that called it, read against the test's project.
    expect(attempt.steps[2]!.source?.file).toBe('tests/two-sessions.e2e.ts');
    assertValidReport(outcome.report);
  });

  it('tells reporters of each such step as it runs, with the session\'s name', () => {
    const attempt = attemptOf('drives a second session between its own steps');
    const tapped = attempt.steps[2]!;
    const told = events.filter((event) => event.type === 'step' && event.progress.identity?.stepId === tapped.id);
    expect(told.map((event) => event.type === 'step' && event.progress.phase)).toEqual(expect.arrayContaining(['start', 'end']));
    for (const event of told) {
      expect(event.type === 'step' && event.progress.identity).toMatchObject({ stepIndex: 2, actor: 'launch-1', attemptId: attempt.id });
    }
    const own = events.find((event) => event.type === 'step' && event.progress.identity?.stepId === attempt.steps[0]!.id);
    expect(own?.type === 'step' && own.progress.identity).not.toHaveProperty('actor');
  });

  it('names each session in the order the test opened them', () => {
    expect(attemptOf('opens two more sessions').steps.map((step) => [step.actor, step.label])).toEqual([
      [undefined, '/'],
      ['launch-2', '/b'],
      ['launch-1', '/a'],
    ]);
  });

  it('keeps the session\'s video among the test\'s artifacts, under its name', () => {
    const attempt = attemptOf('drives a second session between its own steps');
    expect(attempt.artifacts.filter((artifact) => artifact.kind === 'video').map((video) => video.actor)).toEqual([undefined, 'launch-1']);
    const [kept] = sessionVideos('drives a second session between its own steps');
    expect(kept!.path).toMatch(/video\/launch-1\.webm$/);
    expect(kept!.startedAt).toBeDefined();
    expect(existsSync(path.join(results(), kept!.path!))).toBe(true);
  });

  it('gives each test that opens a session on a host from outside it that session\'s steps and video', () => {
    for (const [title, label] of [['uses the host opened at the top of the file', '/shared'], ['uses it again', '/shared-again']] as const) {
      expect(attemptOf(title).steps.map((step) => [step.actor, step.label])).toEqual([[undefined, '/'], ['launch-1', label]]);
      expect(sessionVideos(title)).toHaveLength(1);
    }
  });

  it('drops the session\'s video, and its file, by the rule that drops the test\'s own', () => {
    const attempt = attemptOf('passes while keeping videos of failures only');
    expect(attempt.status).toBe('passed');
    expect(attempt.steps.some((step) => step.actor === 'launch-1')).toBe(true);
    expect(attempt.artifacts.filter((artifact) => artifact.kind === 'video')).toEqual([]);
    // Every session video still on disk is one some attempt kept.
    const { results: ordinary, serialGroups } = outcome.report.run;
    const artifacts = [...ordinary, ...serialGroups].flatMap((result) => result.attempts.flatMap((each) => each.artifacts));
    const kept = new Set(artifacts.flatMap((artifact) => (artifact.actor === undefined || artifact.path === undefined ? [] : [artifact.path])));
    const onDisk = readdirSync(results(), { recursive: true, encoding: 'utf8' }).map((file) => file.split(path.sep).join('/')).filter((file) => /\/video\/[^/]*launch-\d/u.test(file));
    expect(onDisk.toSorted()).toEqual([...kept].toSorted());
  });

  it('closes the host and session the test left open, and keeps the session\'s video', () => {
    const attempt = attemptOf('never closes the host and session it opened');
    expect(attempt.status, JSON.stringify(attempt.error)).toBe('passed');
    expect(attempt.secondaryErrors).toEqual([]);
    expect(attempt.cleanup).toBe('complete');
    expect(sessionVideos('never closes the host and session it opened')).toHaveLength(1);
    const left = (globalThis as { launchReportLeftOpen?: FakeEngineHandle }).launchReportLeftOpen!;
    expect(left.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
  });

  it('records the steps a session opened outside every test runs in each test that uses it, and leaves its end to the file', () => {
    for (const [title, label] of [['uses the session opened at the top of the file', '/visit'], ['uses that session again', '/visit-again']] as const) {
      const attempt = attemptOf(title);
      expect(attempt.status, JSON.stringify(attempt.error)).toBe('passed');
      expect(attempt.steps.map((step) => [step.actor, step.label])).toEqual([[undefined, '/'], ['launch-1', label]]);
      // No test opened it, so no test recorded it.
      expect(sessionVideos(title)).toEqual([]);
    }
  });

  it('keeps a hosted recording of the session as a link under its name', () => {
    expect(sessionVideos('keeps the link of a session a hosted service recorded').map((video) => [video.actor, video.url ?? video.path?.split('/').at(-1)])).toEqual([
      ['launch-1', 'https://videos.example.test/session-2'],
      ['launch-1', 'launch-1.webm'],
    ]);
  });

  it('fails the test for a step of the session the body left running, and closes the session under it', () => {
    const attempt = attemptOf('leaves a step of the second session running');
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', message: expect.stringContaining('locator.waitFor') });
    expect(attempt.steps.at(-1)).toMatchObject({ actor: 'launch-1', api: 'locator.waitFor', status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
    // The step the test never awaited was cancelled and observed: nothing of it reaches another test or the run.
    expect(attempt.secondaryErrors).toEqual([]);
    expect(outcome.report.run.results.flatMap((result) => result.attempts).filter((each) => each.error?.code === 'UNHANDLED_REJECTION')).toEqual([]);
    expect(sessionVideos('leaves a step of the second session running')).toHaveLength(1);
  });

  it('fails the test for an opening the body left in flight, and cancels it without a stray rejection', () => {
    const attempt = attemptOf('never awaits the session it opens');
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', message: expect.stringContaining('host.newSession()') });
    expect(attempt.secondaryErrors).toEqual([]);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.report.run.results.flatMap((result) => result.attempts).filter((each) => each.error?.code === 'UNHANDLED_REJECTION')).toEqual([]);
  });

  it('passes a test that awaited a launch or newSession and caught its rejection', () => {
    const titles = [
      'catches a launch refused for its options',
      'catches a launch whose engine fails to start',
      'catches a launch whose working directory cannot be resolved',
      'catches a launch whose options throw when read',
      'catches a launch that cannot make its output directory',
      'catches a launch that fails to start and then to remove its output directory',
      'catches a session refused for its state',
      'catches a session whose engine fails to start it',
    ];
    expect(Object.fromEntries(titles.map((title) => [title, attemptOf(title).error?.code ?? attemptOf(title).status]))).toEqual(Object.fromEntries(titles.map((title) => [title, 'passed'])));
    expect(titles.flatMap((title) => attemptOf(title).secondaryErrors)).toEqual([]);
    // Each opening did fail, and the test caught what it failed with.
    const refused = (globalThis as { launchReportRefused?: Record<string, string> }).launchReportRefused;
    expect(refused).toEqual({ options: 'INVALID_ARGUMENT', init: expect.any(String), cwd: 'ERR_INVALID_ARG_TYPE', getter: 'NO_MOUNT', mkdtemp: 'ENOENT', cleanup: expect.any(String), state: 'INVALID_ARGUMENT', start: expect.any(String) });
    // The engine's failure, not the cleanup's that came after it.
    expect(refused!.cleanup).toBe(refused!.init);
    expect(Object.values(refused!)).not.toContain('opened');
  });

  it('fails the test for a launch the body left in flight, and cancels it without a stray rejection', () => {
    const attempt = attemptOf('never awaits the host it launches');
    expect(attempt.error).toMatchObject({ code: 'STEP_NOT_AWAITED', message: expect.stringContaining('launch()') });
    expect(attempt.secondaryErrors).toEqual([]);
    expect(outcome.report.run.errors).toEqual([]);
    expect(outcome.report.run.results.flatMap((result) => result.attempts).filter((each) => each.error?.code === 'UNHANDLED_REJECTION')).toEqual([]);
  });

  it('shows the test\'s own screen for a failure on the second session, without matching that session\'s locator against it', () => {
    const attempt = attemptOf('fails a locator on the second session');
    expect(attempt.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
    expect(attempt.steps.at(-1)).toMatchObject({ actor: 'launch-1', status: 'failed' });
    // The test's own screen has a "Send" button, the very one the other session's locator asked for.
    expect(attempt.failure?.screen).toBeDefined();
    expect(attempt.failure?.candidates).toBeUndefined();
    const page = readFileSync(path.join(results(), path.dirname(path.dirname(attempt.artifacts[0]!.path!)), 'trace.md'), 'utf8');
    expect(page).toContain("## Screen of the test's own session at failure");
    expect(page).not.toContain('Closest to what the locator asked for');
  });

  it('cuts a step of the session the test timed out under, at once, and keeps the video of the failure', () => {
    const attempt = attemptOf('times out while a step of the second session waits');
    expect(attempt.status).toBe('timed-out');
    const cut = attempt.steps.find((step) => step.api === 'locator.waitFor')!;
    expect(cut).toMatchObject({ actor: 'launch-1', status: 'cancelled' });
    // Cut when the body timed out, well before the five seconds the session would have waited.
    expect(cut.durationMs).toBeLessThan(4_000);
    expect(sessionVideos('times out while a step of the second session waits')).toHaveLength(1);
    // And cut before teardown ran, not only when the attempt was over.
    expect((globalThis as { launchReportInTeardown?: string }).launchReportInTeardown).toBe('CANCELLED');
  });

  it('leaves a host a worker fixture launched to the worker, and records its steps in each test that uses it', () => {
    for (const [title, label] of [['uses the session a worker fixture opened', '/worker-first'], ['uses that fixture again', '/worker-second']] as const) {
      const attempt = attemptOf(title);
      expect(attempt.status, JSON.stringify(attempt.error)).toBe('passed');
      expect(attempt.steps.map((step) => [step.actor, step.label])).toEqual([[undefined, '/'], ['launch-1', label]]);
      expect(sessionVideos(title)).toEqual([]);
    }
    // One session served both tests, and ended when the worker did.
    expect((globalThis as { launchReportWorkerFixture?: FakeEngineHandle }).launchReportWorkerFixture!.stats()).toMatchObject({ attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
  });

  it('owns a host a hook of the test launched, and closes it with the test', () => {
    const attempt = attemptOf('uses the session its hook opened');
    expect(attempt.status, JSON.stringify(attempt.error)).toBe('passed');
    expect(attempt.steps.map((step) => [step.actor, step.label])).toEqual([[undefined, '/'], ['launch-1', '/from-the-hook']]);
    expect((globalThis as { launchReportFromHook?: FakeEngineHandle }).launchReportFromHook!.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
  });

  it('records each attempt\'s own session when the test retries', () => {
    const attempts = attemptsOf('passes on its retry');
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'passed']);
    expect(attempts.map((attempt) => attempt.steps.filter((step) => step.actor === 'launch-1').map((step) => step.label))).toEqual([['/try-1'], ['/try-2']]);
  });

  it('keeps the videos of two serial members\' sessions apart, though they share a directory and a name', () => {
    const [group] = outcome.report.run.serialGroups;
    const videos = group!.attempts[0]!.artifacts.filter((artifact) => artifact.kind === 'video' && artifact.actor !== undefined);
    expect(videos.map((video) => video.actor)).toEqual(['launch-1', 'launch-1']);
    expect(new Set(videos.map((video) => video.path)).size).toBe(2);
    for (const video of videos) expect(existsSync(path.join(results(), video.path!))).toBe(true);
    expect(group!.attempts[0]!.members.map((member) => member.steps.filter((step) => step.actor !== undefined).map((step) => [step.actor, step.label]))).toEqual([
      [['launch-1', '/first']],
      [['launch-1', '/second']],
    ]);
  });
});
