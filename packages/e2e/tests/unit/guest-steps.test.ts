import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { publishAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { isAbandonedRejection } from '@e2e-dev/core/lib/internal/abandoned';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import type { ArtifactSink } from '@e2e-dev/core/lib/run/fixtures';
import { mirrorGuestSteps } from '@e2e-dev/core/lib/run/guest-steps';
import { StepRecorder, type StepProgress, type StepRecord } from '@e2e-dev/core/lib/run/steps';
import { AttemptGuestSessions } from '../../src/run/guests.ts';

const ROOT = path.resolve('/projects/shop');

/** A test's recorder, and a second session's recorder whose steps are mirrored into it as `actor`. */
function pair(actor = 'launch-1', options: { sessionRoot?: string; redact?: (text: string) => string } = {}) {
  const told: StepProgress[] = [];
  const test = new StepRecorder('test-attempt', { projectRoot: ROOT, onProgress: (progress) => told.push(progress), ...(options.redact === undefined ? {} : { redact: options.redact }) });
  const mirror = mirrorGuestSteps(test, actor, options.sessionRoot ?? ROOT);
  const session = new StepRecorder('session-attempt', { mirror: mirror.progress });
  return { test, session, mirror, told };
}

describe('the steps of a session a test drives beside its own', () => {
  it('records each under the session\'s name, at the index its start takes', async () => {
    const { test, session } = pair();
    await test.run('app', 'app.open', '/', async () => undefined);
    await session.run('locator', 'locator.tap', 'Confirm', async () => {
      session.recordEvent({ kind: 'engine', startedAt: new Date().toISOString(), durationMs: 3, status: 'passed', detail: 'tap button "Confirm"' });
    });
    await test.run('locator', 'locator.tap', 'Send', async () => undefined);
    expect(test.all().map((step) => [step.index, step.id, step.actor, step.api, step.label])).toEqual([
      [0, 'test-attempt:0', undefined, 'app.open', '/'],
      [1, 'test-attempt:1', 'launch-1', 'locator.tap', 'Confirm'],
      [2, 'test-attempt:2', undefined, 'locator.tap', 'Send'],
    ]);
    expect(test.all()[1]!.events.map((event) => event.detail)).toEqual(['tap button "Confirm"']);
    expect(test.all()[1]!.artifacts).toEqual([]);
  });

  it('tells reporters of the step under the test\'s own identity, with the session\'s name', async () => {
    const { session, told } = pair('launch-2');
    await session.run('app', 'app.open', '/b', async () => undefined);
    expect(told.map((progress) => [progress.phase, progress.identity])).toEqual([
      ['start', { attemptId: 'test-attempt', attemptIndex: 0, stepId: 'test-attempt:0', stepIndex: 0, actor: 'launch-2' }],
      ['end', { attemptId: 'test-attempt', attemptIndex: 0, stepId: 'test-attempt:0', stepIndex: 0, actor: 'launch-2' }],
    ]);
  });

  it('keeps a failed step\'s status and error', async () => {
    const { test, session } = pair();
    await expect(session.run('locator', 'locator.tap', 'Missing', async () => { throw new Error('no such button'); })).rejects.toThrow('no such button');
    expect(test.all()[0]).toMatchObject({ actor: 'launch-1', status: 'failed', error: { message: 'no such button' } });
  });

  it('takes what an agent step spent, as a copy the session cannot change afterwards', async () => {
    const { test, session } = pair();
    const model = { provider: 'gateway', model: 'm', endpoint: 'e', adapterVersion: '1', policyVersion: '1', calls: 2, tokenAccounting: 'provider' as const, peakTokensPerCall: 10, inputTokens: 30, outputTokens: 5 };
    const turns = [{ index: 1, calls: ['tap({"target":"n1"})'], outcome: 'tapped' }];
    await session.run('agent', 'agent.act', 'Confirm the order', async () => {
      session.attachAgentDetails({ metrics: { modelCalls: 2, actionSteps: 1, observationBytes: 9, contextBytes: 9, ledgerBytes: 0 }, model, turns });
    });
    expect(test.all()[0]).toMatchObject({ kind: 'agent', actor: 'launch-1', metrics: { modelCalls: 2 }, model: { inputTokens: 30 }, turns });
    turns[0]!.outcome = 'changed by the session later';
    expect(test.all()[0]!.turns![0]!.outcome).toBe('tapped');
  });

  it('redacts the prose the session reports with the test\'s own redactor, whatever the session knew', async () => {
    const value = 'known-to-the-test-only-7719';
    const { test, session } = pair('launch-1', { redact: (text) => text.replaceAll(value, '<secret:otp>') });
    await expect(
      session.run('agent', 'agent.act', `the code ${value}`, async () => {
        session.recordEvent({ kind: 'model', startedAt: new Date().toISOString(), durationMs: 1, status: 'passed', detail: `typed ${value}`, reasoning: `I read ${value}` });
        session.attachAgentDetails({
          explanation: `the screen showed ${value}`,
          turns: [{ index: 1, calls: [`type({"text":"${value}"})`], outcome: `typed ${value}` }],
          cache: { mode: 'missed', replayedActions: 0, totalActions: 1, detail: `the screen read ${value}` },
        });
        throw new Error(`the screen read ${value}`);
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(test.all())).not.toContain(value);
    expect(test.all()[0]).toMatchObject({
      label: 'the code <secret:otp>',
      explanation: 'the screen showed <secret:otp>',
      error: { message: 'the screen read <secret:otp>' },
      turns: [{ calls: ['type({"text":"<secret:otp>"})'], outcome: 'typed <secret:otp>' }],
      cache: { detail: 'the screen read <secret:otp>' },
    });
    expect(test.all()[0]!.events[0]).toMatchObject({ detail: 'typed <secret:otp>', reasoning: 'I read <secret:otp>' });
  });

  it('hands the test a long label whole, so the test redacts a value it alone knows past the report\'s cut', async () => {
    const value = 'known-to-the-test-only-7719';
    const { test, session } = pair('launch-1', { redact: (text) => text.replaceAll(value, '<secret:otp>') });
    const long = `${'x'.repeat(8185)}${value}`;
    await session.run('resource', 'request.get', long, async () => {});
    expect(test.all()[0]!.label).toBe(`${'x'.repeat(8185)}<secret:otp>`);
  });

  it('reads the session\'s test lines against the test\'s project, when the session\'s root is another directory', () => {
    const { test, mirror } = pair('launch-1', { sessionRoot: path.join(ROOT, 'packages', 'bot') });
    const theirs = (id: string, file: string): StepRecord => ({
      id, index: 0, kind: 'app', api: 'app.open', label: '/', source: { file, line: 12, column: 3 }, status: 'failed', startedAt: new Date().toISOString(), durationMs: 4, events: [], artifacts: [],
      error: { category: 'test', code: 'LOCATOR_NOT_FOUND', message: 'nothing matched', retryable: false, source: { file, line: 12, column: 9 } },
    });
    for (const record of [theirs('inside', '../../tests/shop.e2e.ts'), theirs('outside', '../../../elsewhere/run.ts')]) {
      mirror.progress({ phase: 'start', kind: 'app', api: 'app.open', label: '/' }, record);
      mirror.progress({ phase: 'end', kind: 'app', api: 'app.open', label: '/', status: 'failed', durationMs: 4, modelCalls: 0 }, record);
    }
    expect(test.all().map((step) => [step.source, step.error?.source])).toEqual([
      [{ file: 'tests/shop.e2e.ts', line: 12, column: 3 }, { file: 'tests/shop.e2e.ts', line: 12, column: 9 }],
      [undefined, undefined],
    ]);
  });

  it('leaves the session\'s steps out of what an agent of the test reads as the steps before its own, and files no event of the test under them', async () => {
    const { test, session } = pair();
    await test.run('app', 'app.open', '/', async () => undefined);
    await session.run('app', 'app.open', '/other', async () => undefined);
    expect(test.completed().map((step) => step.label)).toEqual(['/']);
    // The app navigated on its own after the session's step: that belongs to the test's last own step.
    test.recordAppEvent({ kind: 'navigation', line: 'navigated to /done' });
    expect(test.all().map((step) => step.events.length)).toEqual([1, 0]);
  });

  it('tells a step the attempt ended under as cancelled with what it did so far, and drops what the session reports afterwards', async () => {
    const { test, session, mirror, told } = pair();
    let finish = (): void => undefined;
    const running = session.run('locator', 'locator.waitFor', 'Slow', () => {
      session.recordEvent({ kind: 'engine', startedAt: new Date().toISOString(), durationMs: 1, status: 'passed', detail: 'looked once' });
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    mirror.cut();
    expect(test.all()[0]).toMatchObject({ actor: 'launch-1', status: 'cancelled' });
    expect(test.all()[0]!.events.map((event) => event.detail)).toEqual(['looked once']);
    expect(told.at(-1)).toMatchObject({ phase: 'end', status: 'cancelled' });
    finish();
    await running;
    expect(test.all()[0]!.status).toBe('cancelled');
    await session.run('app', 'app.open', '/late', async () => undefined);
    expect(test.all()).toHaveLength(1);
  });
});

describe('what an attempt offers the hosts and sessions a test opens', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-guests-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function attempt() {
    const steps = new StepRecorder('test-attempt', { projectRoot: ROOT });
    const sink: ArtifactSink = { dir, register: () => 'artifact', link: () => 'artifact' };
    return { steps, guests: new AttemptGuestSessions(steps, sink, { keep: undefined, videoPrefix: '', cleanupTimeout: 1_000 }) };
  }
  /** A session, and what the attempt did to it. */
  function session(busy = false) {
    const seen = { closed: 0, abandoned: 0 };
    return {
      seen,
      session: { root: ROOT, busy: () => busy && seen.closed === 0, abandonRunning: () => { seen.abandoned += 1; return undefined; }, close: async () => { seen.closed += 1; } },
    };
  }

  it('closes the sessions and hosts the test opened, once each, and releases a host only at the attempt\'s own end', async () => {
    const { guests } = attempt();
    const idle = session();
    const running = session(true);
    const host = { closed: 0, released: 0 };
    guests.offer.session().take(idle.session);
    guests.offer.session().take(running.session);
    guests.offer.host().take({ close: async () => { host.closed += 1; }, release: () => { host.released += 1; } });

    // The body is over: only the session a step still runs on is closed before teardown.
    await guests.quiesce();
    expect([idle.seen.closed, running.seen.closed, host.closed, host.released]).toEqual([0, 1, 0, 0]);

    expect(await guests.settle('passed')).toEqual([]);
    expect([idle.seen.closed, running.seen.closed, host.closed, host.released]).toEqual([1, 1, 1, 0]);
    // The host's secrets stay shared until the attempt's artifacts have settled.
    guests.release();
    expect(host.released).toBe(1);
  });

  it('fails the test for an opening the body left in flight, and expects the rejection of the opening it cancels', async () => {
    const { guests } = attempt();
    const opening = guests.offer.session();
    const launching = guests.offer.host();
    const errors = await guests.abandonRunning();
    expect(errors.map((error) => [error.code, error.message])).toEqual([
      ['STEP_NOT_AWAITED', expect.stringContaining('host.newSession()')],
      ['STEP_NOT_AWAITED', expect.stringContaining('launch()')],
    ]);
    expect([opening.signal.aborted, launching.signal.aborted]).toEqual([true, true]);
    const cancelled = new Error('opening the e2e session was cancelled');
    guests.offer.gaveUp(cancelled);
    expect(isAbandonedRejection(cancelled)).toBe(true);
  });

  it('cancels an opening still in flight when the body ends, and takes nothing once the attempt settles', async () => {
    const { guests } = attempt();
    const inFlight = guests.offer.session();
    expect(inFlight.signal.aborted).toBe(false);
    await guests.quiesce();
    expect(inFlight.signal.aborted).toBe(true);
    // Opened in the end after all: nobody takes it, so it is its opener's to close.
    expect(inFlight.take(session().session)).toBeUndefined();

    // A teardown hook may still open one, until the attempt settles.
    const inTeardown = session();
    expect(guests.offer.session().take(inTeardown.session)).toBeDefined();
    await guests.settle('passed');
    expect(inTeardown.seen.closed).toBe(1);
    const late = guests.offer.host();
    expect(late.signal.aborted).toBe(true);
    expect(late.take({ close: async () => undefined, release: () => undefined })).toBeUndefined();
  });

  it('records the steps of a session opened outside every test, and leaves that session alone', async () => {
    const { steps, guests } = attempt();
    const visitor = session(true);
    const visiting = new StepRecorder('visitor', { mirror: guests.offer.visit(visitor.session).progress });
    let finish = (): void => undefined;
    const running = visiting.run('locator', 'locator.waitFor', 'Slow', () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(await guests.abandonRunning()).toEqual([]);
    await guests.settle('passed');
    // Its step is told as cut; the session itself was neither blamed nor closed, and goes on.
    expect(steps.all()[0]).toMatchObject({ actor: 'launch-1', status: 'cancelled' });
    expect(visitor.seen).toEqual({ closed: 0, abandoned: 0 });
    finish();
    await running;
  });

  it('follows a session of another copy of the package, as a project with two installs loads', async () => {
    const { steps, guests } = attempt();
    const ended = new AbortController();
    publishAttempt(
      { attemptId: 'a1', owner: 'suite', testKind: 'test', assertionTimeout: 1_000, budget: new AttemptBudget(ended.signal, new Deadline(1_000)), soft: new SoftFailures(), guests: guests.offer },
      ended.signal,
    );
    try {
      vi.resetModules();
      const copy = { internals: await import('@e2e-dev/core/lib/core/internals'), steps: await import('@e2e-dev/core/lib/run/steps') };
      expect(copy.steps.StepRecorder).not.toBe(StepRecorder);
      const guest = copy.internals.sessionGuest();
      const theirs = new copy.steps.StepRecorder('other-copy', { mirror: guest.mirror });
      expect(guest.attach(session().session)).toBe(true);
      await theirs.run('app', 'app.open', '/from-the-other-copy', async () => undefined);
      expect(steps.all().map((step) => [step.actor, step.label, step.status])).toEqual([['launch-1', '/from-the-other-copy', 'passed']]);
    } finally {
      ended.abort();
    }
  });
});
