import { describe, expect, it } from 'vitest';
import { projectPriorSteps } from '@e2e-dev/core/lib/agent/ledger';
import { publishAttempt, type PublishedAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { SoftFailures } from '@e2e-dev/core/lib/expect/soft';
import { TestError } from '@e2e-dev/core/lib/internal/errors';
import { runTestStep } from '@e2e-dev/core/lib/internal/test-step';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { StepRecorder, type StepHoldRequest, type StepProgress } from '@e2e-dev/core/lib/run/steps';

const tap = (steps: StepRecorder, label: string, body: () => Promise<void> = async () => {}): Promise<void> => steps.run('locator', 'locator.tap', label, body);

/** `[index, api, label, parent, status]` of every step, in record order. */
function told(steps: StepRecorder): unknown[][] {
  return steps.all().map((step) => [step.index, step.api, step.label, step.parent, step.status]);
}

describe('StepRecorder.group', () => {
  it('records the step with the calls made inside it as its children, and returns what the body returns', async () => {
    const steps = new StepRecorder('a');
    await tap(steps, 'before');
    const value = await steps.group('Log in', async () => {
      await tap(steps, 'user');
      await steps.group('Submit', () => tap(steps, 'button'));
      return 7;
    });
    await tap(steps, 'after');

    expect(value).toBe(7);
    expect(told(steps)).toEqual([
      [0, 'locator.tap', 'before', undefined, 'passed'],
      [1, 'test.step', 'Log in', undefined, 'passed'],
      [2, 'locator.tap', 'user', 1, 'passed'],
      [3, 'test.step', 'Submit', 1, 'passed'],
      [4, 'locator.tap', 'button', 3, 'passed'],
      [5, 'locator.tap', 'after', undefined, 'passed'],
    ]);
    expect(steps.all()[1]!.kind).toBe('step');
  });

  it('keeps steps that run side by side under their own test.step', async () => {
    const steps = new StepRecorder('a');
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const both = Promise.all([
      steps.group('A', async () => { await gate; await tap(steps, 'in a'); }),
      steps.group('B', async () => { await gate; await tap(steps, 'in b'); }),
    ]);
    release();
    await both;

    const parentOf = (label: string) => steps.all().find((step) => step.label === label)!.parent;
    expect(parentOf('in a')).toBe(0);
    expect(parentOf('in b')).toBe(1);
  });

  it('fails with a failed call, whose error only the call keeps, and throws that error on', async () => {
    const steps = new StepRecorder('a');
    const failure = new TestError('LOCATOR_NOT_FOUND', 'no button');
    const thrown = await steps.group('Log in', () => tap(steps, 'button', async () => { throw failure; })).catch((error: unknown) => error);

    expect(thrown).toBe(failure);
    const [group, call] = steps.all();
    expect(group).toMatchObject({ status: 'failed' });
    expect(group!.error).toBeUndefined();
    expect(call!.error).toMatchObject({ code: 'LOCATOR_NOT_FOUND' });
  });

  it('keeps the error its own body threw, and one the body wrapped', async () => {
    const steps = new StepRecorder('a');
    await steps.group('Own', () => { throw new TestError('ASSERTION_FAILED', 'wrong total'); }).catch(() => undefined);
    await steps
      .group('Wrapped', async () => {
        try {
          await tap(steps, 'button', async () => { throw new TestError('LOCATOR_NOT_FOUND', 'no button'); });
        } catch (cause) {
          throw new TestError('ASSERTION_FAILED', 'could not log in', { cause });
        }
      })
      .catch(() => undefined);

    expect(steps.all()[0]).toMatchObject({ label: 'Own', status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'wrong total' } });
    expect(steps.all()[1]).toMatchObject({ label: 'Wrapped', status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'could not log in' } });
  });

  it('passes when the body catches a failed call', async () => {
    const steps = new StepRecorder('a');
    await steps.group('Dismiss the banner if any', async () => {
      await tap(steps, 'banner', async () => { throw new TestError('LOCATOR_NOT_FOUND', 'no banner'); }).catch(() => undefined);
    });
    expect(told(steps)).toEqual([
      [0, 'test.step', 'Dismiss the banner if any', undefined, 'passed'],
      [1, 'locator.tap', 'banner', 0, 'failed'],
    ]);
  });

  it('redacts a secret spelled into the title', async () => {
    const steps = new StepRecorder('a', { redact: (text) => text.replaceAll('hunter2', '[redacted]') });
    await steps.group('Log in with hunter2', async () => {});
    expect(steps.all()[0]!.label).toBe('Log in with [redacted]');
  });

  it('redacts a provider key its body set and then quoted in the error it threw', async () => {
    const key = 'sk-step-body-4c1e9a7f2b6d8035e1';
    const steps = new StepRecorder('a', { redact: processSecrets.redact });
    const before = process.env.OPENAI_API_KEY;
    try {
      await steps
        .group('Call the provider', () => {
          process.env.OPENAI_API_KEY = key;
          throw new Error(`request failed with key ${key}`);
        })
        .catch(() => undefined);
    } finally {
      if (before === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = before;
    }
    const error = steps.all()[0]!.error!;
    expect(JSON.stringify(error)).not.toContain(key);
    expect(error.message).toContain('request failed with key');
  });

  it('tells reporters which test.step a step runs inside', async () => {
    const progress: StepProgress[] = [];
    const steps = new StepRecorder('a', { onProgress: (fact) => progress.push(fact) });
    await steps.group('Log in', () => tap(steps, 'button'));

    const starts = progress.filter((fact) => fact.phase === 'start');
    expect(starts.map((fact) => [fact.kind, fact.label, fact.identity?.stepId, fact.identity?.parentStepId])).toEqual([
      ['step', 'Log in', 'a:0', undefined],
      ['locator', 'button', 'a:1', 'a:0'],
    ]);
    const end = progress.findLast((fact) => fact.phase === 'end');
    expect(end).toMatchObject({ kind: 'step', api: 'test.step', label: 'Log in', status: 'passed' });
  });

  it('is never held itself in a stepped run, while each call inside it is', async () => {
    const asked: StepHoldRequest[] = [];
    const steps = new StepRecorder('a', { hold: { steps: true, ask: async (request) => { asked.push(request); } } });
    steps.holdable = true;
    await steps.group('Log in', async () => {
      await tap(steps, 'user');
      await tap(steps, 'button');
    });
    expect(asked.map((request) => [request.kind, request.api, request.label])).toEqual([
      ['step', 'locator.tap', 'user'],
      ['step', 'locator.tap', 'button'],
    ]);
  });

  it('lets a verification inside it prove the steps before that verification', async () => {
    const steps = new StepRecorder('a');
    await tap(steps, 'before');
    await steps.group('Check', async () => {
      await tap(steps, 'inside');
      await steps.run('assertion', 'expect.toBeVisible', 'heading', async () => {}, { verifies: true });
    });
    expect(steps.lastVerifiedStepIndex).toBe(3);
  });

  it('fails as not awaited when the test returns before it ends', async () => {
    const steps = new StepRecorder('a');
    const pending = steps.group('Log in', () => new Promise<void>(() => {}));
    pending.catch(() => undefined);
    const error = steps.abandonRunning();
    expect(error).toMatchObject({ code: 'STEP_NOT_AWAITED' });
    expect(error!.message).toContain('test.step "Log in"');
    expect(error!.message).toContain("a fixture can't call use() inside one");
    expect(steps.all()[0]).toMatchObject({ status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('is no parent to a call its body left running after it ended', async () => {
    const steps = new StepRecorder('a');
    let late: Promise<void> = Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await steps.group('Outer', async () => {
      await steps.group('Inner', async () => {
        late = gate.then(() => tap(steps, 'late'));
      });
      release();
      await late;
    });
    // Called in Inner's async context after Inner ended: Outer is the one still running.
    expect(steps.all().find((step) => step.label === 'late')!.parent).toBe(0);
  });

  it('keeps an error a step outside it recorded, when its body throws that error later', async () => {
    const steps = new StepRecorder('a');
    const failure = new TestError('LOCATOR_NOT_FOUND', 'no button');
    await tap(steps, 'button', async () => { throw failure; }).catch(() => undefined);
    await steps.group('Later', async () => {
      await tap(steps, 'other');
      throw failure;
    }).catch(() => undefined);
    expect(steps.all().find((step) => step.label === 'Later')).toMatchObject({ status: 'failed', error: { code: 'LOCATOR_NOT_FOUND' } });
  });

  it('records no error for either of two calls that fail side by side in it', async () => {
    const steps = new StepRecorder('a');
    await steps
      .group('Both', () =>
        Promise.all([
          tap(steps, 'one', async () => { throw new TestError('LOCATOR_NOT_FOUND', 'no one'); }),
          tap(steps, 'two', async () => { throw new TestError('LOCATOR_NOT_FOUND', 'no two'); }),
        ]),
      )
      .catch(() => undefined);
    expect(steps.all()[0]).toMatchObject({ status: 'failed' });
    expect(steps.all()[0]!.error).toBeUndefined();
  });

  it('passes when its body throws what the caller calls a verdict, and throws it on', async () => {
    const steps = new StepRecorder('a');
    const skip = { skipped: true };
    const thrown = await steps.group('Check the platform', () => { throw skip; }, { passesThrough: (value) => value === skip }).catch((error: unknown) => error);
    expect(thrown).toBe(skip);
    expect(steps.all()[0]).toMatchObject({ status: 'passed' });
    expect(steps.all()[0]!.error).toBeUndefined();
  });

  it('is cut with the attempt, as the call running in it is, and when its body waits on no call', async () => {
    const cut = new AbortController();
    const steps = new StepRecorder('a', { signal: cut.signal });
    const withCall = steps.group('Log in', () => tap(steps, 'button', () => new Promise<void>(() => {}))).catch((error: unknown) => error);
    const alone = steps.group('Wait', () => new Promise<void>(() => {})).catch((error: unknown) => error);
    cut.abort(new TestError('CANCELLED', 'the test timed out'));
    expect(await withCall).toMatchObject({ code: 'CANCELLED' });
    expect(await alone).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all().map((step) => [step.label, step.status, step.error?.code])).toEqual([
      ['Log in', 'cancelled', undefined],
      ['button', 'cancelled', 'CANCELLED'],
      ['Wait', 'cancelled', 'CANCELLED'],
    ]);
    expect(steps.busy).toBe(false);
  });

  it('keeps the cancellation on the call alone, however many awaits sit between the call and the step', async () => {
    const cut = new AbortController();
    const steps = new StepRecorder('a', { signal: cut.signal });
    const pending = steps
      .group('Log in', async () => {
        await (async () => { await tap(steps, 'button', () => new Promise<void>(() => {})); })();
      })
      .catch((error: unknown) => error);
    cut.abort(new TestError('CANCELLED', 'the test timed out'));
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all().map((step) => [step.label, step.status, step.error?.code])).toEqual([
      ['Log in', 'cancelled', undefined],
      ['button', 'cancelled', 'CANCELLED'],
    ]);
  });

  it('ends after a call another session runs inside it', async () => {
    const cut = new AbortController();
    const steps = new StepRecorder('a');
    let guest: ReturnType<StepRecorder['guest']> | undefined;
    const pending = steps
      .group('Second user waits', () => {
        guest = steps.guest({ kind: 'locator', api: 'locator.waitFor', label: 'button', actor: 'launch-1', source: undefined });
        return new Promise<void>(() => {});
      }, { signal: cut.signal })
      .catch((error: unknown) => error);
    cut.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(steps.busy).toBe(true);
    guest!.end({ status: 'cancelled', durationMs: 1 });
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all().map((step) => [step.label, step.status, step.parent])).toEqual([
      ['Second user waits', 'cancelled', undefined],
      ['button', 'cancelled', 0],
    ]);
  });

  it('ends after a call its body starts in answer to the cut', async () => {
    const cut = new AbortController();
    const steps = new StepRecorder('a', { signal: cut.signal });
    let cleanup: ReturnType<StepRecorder['guest']> | undefined;
    const pending = steps
      .group('Log in', async () => {
        try {
          await tap(steps, 'button', () => new Promise<void>(() => {}));
        } catch {
          cleanup = steps.guest({ kind: 'locator', api: 'locator.tap', label: 'cleanup', actor: 'launch-1', source: undefined });
          await new Promise<void>(() => {});
        }
      })
      .catch((error: unknown) => error);
    cut.abort(new TestError('CANCELLED', 'the test timed out'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(steps.busy).toBe(true);
    cleanup!.end({ status: 'passed', durationMs: 1 });
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all().map((step) => [step.label, step.status])).toEqual([['Log in', 'cancelled'], ['button', 'cancelled'], ['cleanup', 'passed']]);
  });

  it('is cut by the signal it is given beside the recorder\'s own', async () => {
    const phase = new AbortController();
    const steps = new StepRecorder('a', { signal: new AbortController().signal });
    const pending = steps.group('Wait', () => new Promise<void>(() => {}), { signal: phase.signal }).catch((error: unknown) => error);
    phase.abort();
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all()[0]).toMatchObject({ status: 'cancelled' });
  });

  it('ends after the call the attempt cut inside it, so the call is cancelled and not left running', async () => {
    const cut = new AbortController();
    const steps = new StepRecorder('a');
    let endCall = (): void => {};
    const pending = steps
      .group('Log in', () => tap(steps, 'button', () => new Promise<void>((_, reject) => { endCall = () => reject(new TestError('CANCELLED', 'the engine cut the call')); })), { signal: cut.signal })
      .catch((error: unknown) => error);
    cut.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(steps.busy).toBe(true);
    endCall();
    expect(await pending).toMatchObject({ code: 'CANCELLED' });
    expect(steps.all().map((step) => [step.label, step.status])).toEqual([['Log in', 'cancelled'], ['button', 'cancelled']]);
    expect(steps.abandonRunning()).toBeUndefined();
  });

  it('stays the parent of a held call the test returned before releasing', async () => {
    const steps = new StepRecorder('a', { hold: { steps: true, ask: () => new Promise<void>(() => {}) } });
    steps.holdable = true;
    steps.group('Log in', () => tap(steps, 'held')).catch(() => undefined);
    await Promise.resolve();
    steps.abandonRunning();
    expect(steps.all().find((step) => step.label === 'held')).toMatchObject({ parent: 0, status: 'failed', error: { code: 'STEP_NOT_AWAITED' } });
  });

  it('leaves what the app does between its calls to the last call, not to itself', async () => {
    const steps = new StepRecorder('a');
    await tap(steps, 'before');
    await steps.group('Log in', async () => {
      steps.recordAppEvent({ kind: 'navigation', line: 'navigated to /login' });
      steps.attachArtifact('artifact-1');
    });
    const [before, group] = steps.all();
    expect(before).toMatchObject({ artifacts: ['artifact-1'], events: [{ kind: 'navigation' }] });
    expect(group).toMatchObject({ artifacts: [], events: [] });
  });

  it('is left out of the prior steps an agent step is told', async () => {
    const steps = new StepRecorder('a');
    await steps.group('Log in', () => tap(steps, 'button'));
    expect(projectPriorSteps(steps.completed()).map((step) => step.api)).toEqual(['locator.tap']);
  });
});

describe('test.step', () => {
  function attempt(overrides: Partial<PublishedAttempt>): { readonly end: () => void } {
    const live = new AbortController();
    publishAttempt(
      {
        attemptId: 'a',
        owner: 'suite',
        testKind: 'test',
        assertionTimeout: 1_000,
        budget: new AttemptBudget(live.signal, new Deadline(1_000)),
        soft: new SoftFailures(),
        ...overrides,
      },
      live.signal,
    );
    return { end: () => live.abort() };
  }

  it('is a collection error outside a test', async () => {
    await expect(runTestStep('Log in', async () => {})).rejects.toMatchObject({ code: 'COLLECTION_ERROR' });
  });

  it('runs on the attempt\'s recorder', async () => {
    const steps = new StepRecorder('a');
    const running = attempt({ step: (title, body) => steps.group(title, body) });
    try {
      await expect(runTestStep('Log in', () => 'done')).resolves.toBe('done');
      expect(told(steps)).toEqual([[0, 'test.step', 'Log in', undefined, 'passed']]);
    } finally {
      running.end();
    }
  });

  it('just runs the body where the attempt records no steps', async () => {
    const running = attempt({});
    try {
      await expect(runTestStep('Log in', () => 'done')).resolves.toBe('done');
    } finally {
      running.end();
    }
  });

  it('rejects a blank title and a missing body before anything runs', async () => {
    const steps = new StepRecorder('a');
    const running = attempt({ step: (title, body) => steps.group(title, body) });
    try {
      await expect(runTestStep('  ', async () => {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      // @ts-expect-error a JavaScript caller can leave the body out
      await expect(runTestStep('Log in', undefined)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(steps.all()).toEqual([]);
    } finally {
      running.end();
    }
  });
});
