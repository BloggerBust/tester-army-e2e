/**
 * Which steps may confirm a staged action trace (cache/context.ts): the ones
 * minted as verification steps, whatever their kind or api name.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StepRecorder, type StepCacheInfo } from '@e2e-dev/core/lib/run/steps';
import { AgentError } from '@e2e-dev/core/lib/agent/error';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';

const pass = async (): Promise<void> => undefined;

it('refreshes provider key registration before recording a failure', async () => {
  const key = randomUUID();
  let registeredDuringSerialization = false;
  const steps = new StepRecorder('attempt', {
    redact(text) {
      if (text === 'fixture failure') registeredDuringSerialization = processSecrets.redact(key) === '<secret:OPENAI_API_KEY>';
      return text;
    },
  });
  try {
    await expect(steps.run('agent', 'agent.act', 'fixture step', async () => {
      vi.stubEnv('OPENAI_API_KEY', key);
      throw new Error('fixture failure');
    })).rejects.toThrow('fixture failure');
    expect(registeredDuringSerialization).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('redacts recorded model metadata only in the step record', async () => {
  const redact = (text: string): string => text.replaceAll('fixture-value', '<secret:fixture>');
  const steps = new StepRecorder('attempt', { redact });
  const cache: StepCacheInfo = {
    mode: 'self-finalized', replayedActions: 2, totalActions: 2, entry: 'entry-key',
    recordedBy: { provider: 'fixture-value', model: 'model-fixture-value' },
  };
  await steps.run('agent', 'agent.act', 'replayed step', async () => steps.attachAgentDetails({ cache }));
  expect(steps.all()[0]?.cache).toEqual({ ...cache, recordedBy: { provider: '<secret:fixture>', model: 'model-<secret:fixture>' } });
  expect(cache.recordedBy).toEqual({ provider: 'fixture-value', model: 'model-fixture-value' });
});

it('redacts a guest step cache with the host ledger and drops attribution that no longer fits the report', async () => {
  const redact = (text: string): string => text.replaceAll('!', '<secret:fixture>');
  const steps = new StepRecorder('attempt', { redact });
  const cache: StepCacheInfo = {
    mode: 'self-finalized', replayedActions: 2, totalActions: 2, entry: 'entry-key',
    recordedBy: { provider: 'provider!', model: 'model!' },
  };
  const guest = steps.guest({ kind: 'agent', api: 'agent.act', label: 'guest step', actor: 'fixture-guest', source: undefined });
  guest.end({ status: 'passed', durationMs: 1, cache });
  expect(steps.all()[0]?.cache?.recordedBy).toEqual({ provider: 'provider<secret:fixture>', model: 'model<secret:fixture>' });
  expect(cache.recordedBy).toEqual({ provider: 'provider!', model: 'model!' });

  const longCache = { ...cache, recordedBy: { provider: 'provider', model: `${'m'.repeat(299)}!` } };
  await steps.run('agent', 'agent.act', 'own step', async () => steps.attachAgentDetails({ cache: longCache }));
  expect(steps.all()[1]?.cache).toEqual({ mode: 'self-finalized', replayedActions: 2, totalActions: 2, entry: 'entry-key' });
});

describe('StepRecorder.lastVerifiedStepIndex', () => {
  it('is -1 until a verification step passes', async () => {
    const steps = new StepRecorder('attempt');
    expect(steps.lastVerifiedStepIndex).toBe(-1);
    await steps.run('agent', 'agent.act', 'add an expense', pass);
    await steps.run('app', 'app.open', '/', pass);
    await steps.run('locator', 'locator.click', 'button "Save"', pass);
    expect(steps.lastVerifiedStepIndex).toBe(-1);
  });

  it('advances to each passed verification step, whatever its kind', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('agent', 'agent.act', 'add an expense', pass);
    await steps.run('assertion', 'expect.toBeVisible', 'the new row', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(1);
    await steps.run('agent', 'agent.act', 'approve it', pass);
    await steps.run('agent', 'agent.assert', 'the row reads approved', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(3);
    await steps.run('locator', 'locator.waitFor', 'toast → visible', pass, { verifies: true });
    expect(steps.lastVerifiedStepIndex).toBe(4);
  });

  it('keeps counting step indexes when it retains only the newest steps', async () => {
    const steps = new StepRecorder('attempt', { retainSteps: 2 });
    for (let index = 0; index < 5; index += 1) await steps.run('locator', 'locator.textContent', `row ${index}`, pass);
    await steps.run('locator', 'locator.waitFor', 'toast → visible', pass, { verifies: true });
    expect(steps.all().map((step) => step.index)).toEqual([4, 5]);
    expect(steps.lastVerifiedStepIndex).toBe(5);
  });

  it('throws a failed step\'s error classified and redacted when asked to', async () => {
    const redact = (text: string): string => text.replaceAll('hunter2', '[SECRET]');
    const thrown = new Error('the page printed hunter2', { cause: new Error('driver saw hunter2') });
    const steps = new StepRecorder('attempt', { redact, redactThrown: true });
    const caught = await steps.run('app', 'app.open', '/', () => Promise.reject(thrown)).then(() => undefined, (cause: Error) => cause);
    expect(caught).toMatchObject({ code: 'ERROR', cause: thrown });
    expect(`${thrown.message} ${thrown.stack} ${(thrown.cause as Error).message}`).not.toContain('hunter2');
    const kept = new Error('the page printed hunter2');
    await new StepRecorder('attempt', { redact }).run('app', 'app.open', '/', () => Promise.reject(kept)).catch(() => undefined);
    expect(kept.message).toContain('hunter2');
  });

  it('keeps the cause of an agent error that is not a failed model call, such as a hook\'s own error', async () => {
    const mine = new Error('the test stopped the run');
    const steps = new StepRecorder('attempt', { redact: (text) => text, redactThrown: true });
    const caught = await steps.run('agent', 'agent.act', 'x', () => Promise.reject(new AgentError('ACTION_FAILED', 'hook failed', { cause: mine }))).then(() => undefined, (cause: Error) => cause);
    expect(caught?.cause).toBe(mine);
  });

  it('rebuilds a failed model call, from this copy or another, as its own agent error with its text redacted and no cause', async () => {
    const redact = (text: string): string => text.replaceAll('sk-fake-step-7d2e', '<secret:k>');
    // As another installed copy of core throws it: the brand, not this copy's class.
    const foreign = Object.assign(new Error('provider said sk-fake-step-7d2e'), {
      code: 'MODEL_PROVIDER_FAILED', explanation: 'provider said sk-fake-step-7d2e', blocked: false,
      cause: { responseBody: 'sk-fake-step-7d2e' },
    });
    Object.defineProperty(foreign, Symbol.for('e2e.agent-error.v1'), { value: true });
    for (const thrown of [foreign, new AgentError('MODEL_PROVIDER_FAILED', 'provider said sk-fake-step-7d2e', { cause: { responseBody: 'sk-fake-step-7d2e' } })]) {
      for (const redactThrown of [false, true]) {
        const caught = await new StepRecorder('attempt', { redact, redactThrown }).run('agent', 'agent.act', 'x', () => Promise.reject(thrown)).then(() => undefined, (cause: unknown) => cause);
        expect(caught).toBeInstanceOf(AgentError);
        expect(caught).toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: 'provider said <secret:k>', explanation: 'provider said <secret:k>' });
        expect((caught as Error).cause).toBeUndefined();
      }
    }
  });

  it.each(['CONTEXT_OVERFLOW', 'MODEL_OUTPUT_INVALID'] as const)('drops the raw cause from %s', async (code) => {
    const key = 'sk-fake-model-error-29c8';
    const redact = (text: string): string => text.replaceAll(key, '<secret:k>');
    for (const redactThrown of [false, true]) {
      const steps = new StepRecorder('attempt', { redact, redactThrown });
      const thrown = new AgentError(code, `provider said ${key}`, { cause: { responseBody: key } });
      const caught = await steps.run('agent', 'agent.act', 'x', () => Promise.reject(thrown)).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code, message: 'provider said <secret:k>' });
      expect(caught).not.toHaveProperty('cause');
    }
  });

  it('sanitizes a provider error after the caller leaves the step running', async () => {
    const key = 'sk-fake-late-model-4775';
    const redact = (text: string): string => text.replaceAll(key, '<secret:k>');
    const steps = new StepRecorder('attempt', { redact });
    const gate = deferred();
    const work = steps.run('agent', 'agent.act', 'x', async () => {
      await gate.promise;
      throw new AgentError('MODEL_PROVIDER_FAILED', `provider said ${key}`, { cause: { responseBody: key } });
    });
    expect(steps.abandonRunning()?.code).toBe('STEP_NOT_AWAITED');
    gate.resolve();
    const caught = await work.catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'MODEL_PROVIDER_FAILED', message: 'provider said <secret:k>' });
    expect(caught).not.toHaveProperty('cause');
    expect(steps.all()[0]?.error?.code).toBe('STEP_NOT_AWAITED');
  });

  it('does not advance on a verification step that failed', async () => {
    const steps = new StepRecorder('attempt');
    await steps.run('assertion', 'expect.toBeVisible', 'the row', pass, { verifies: true });
    await expect(
      steps.run(
        'assertion',
        'expect.toHaveText',
        'the row',
        async () => {
          throw new Error('mismatch');
        },
        { verifies: true },
      ),
    ).rejects.toThrow('mismatch');
    expect(steps.lastVerifiedStepIndex).toBe(0);
  });
});

describe('async step ownership', () => {
  it('attributes overlapping siblings and nested work to their own scopes', async () => {
    const steps = new StepRecorder('attempt');
    const firstGate = deferred();
    const secondGate = deferred();
    const first = steps.run('resource', 'first', '', async () => {
      await firstGate.promise;
      steps.attachArtifact('first');
    });
    const second = steps.run('resource', 'second', '', async () => {
      await secondGate.promise;
      expect(steps.currentStepId).toBe('attempt:1');
      await steps.run('resource', 'nested', '', async () => { steps.attachArtifact('nested'); });
      steps.attachArtifact('second');
    });
    firstGate.resolve();
    await first;
    expect(steps.currentStepId).toBeUndefined();
    secondGate.resolve();
    await second;
    expect(steps.currentStepId).toBeUndefined();
    expect(steps.all().map((step) => step.artifacts)).toEqual([['first'], ['second'], ['nested']]);
  });

  it('ignores late work inherited from a completed step instead of attaching it to a newer step', async () => {
    const steps = new StepRecorder('attempt');
    const lateGate = deferred();
    let late: Promise<void> | undefined;
    await steps.run('resource', 'finished', '', async () => {
      late = lateGate.promise.then(() => {
        steps.attachArtifact('late');
        steps.attachViewport({ width: 1, height: 1, scale: 1 });
        steps.recordEvent({ kind: 'engine', startedAt: '', durationMs: 0, status: 'passed' });
      });
    });
    await steps.run('resource', 'newer', '', async () => { lateGate.resolve(); await late; });
    for (const step of steps.all()) {
      expect(step.artifacts).toEqual([]);
      expect(step.events).toEqual([]);
      expect(step.viewport).toBeUndefined();
    }
  });
});

/** A gate for controlling completion order without relying on timers. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
