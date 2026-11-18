/** StepRecorder.nameRunning: the steps a close cut, each failing by its own name. */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2EError } from '@e2e-dev/core/lib/internal/errors';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';

const closed = (): E2EError => new E2EError('infrastructure', 'CANCELLED', 'the session is closed');
const cut = (call: string): E2EError => new E2EError('infrastructure', 'CANCELLED', `the session closed while ${call} was running`);
const never = (): Promise<void> => new Promise(() => undefined);
const failure = (step: Promise<unknown>): Promise<Error | undefined> => step.then(() => undefined, (cause: Error) => cause);

function recorder(): { steps: StepRecorder; end: AbortController } {
  const end = new AbortController();
  return { steps: new StepRecorder('attempt', { projectRoot: path.join(process.cwd(), 'tests'), signal: end.signal }), end };
}

describe('StepRecorder.nameRunning', () => {
  it('fails each running step with its own error at the line that called it, a nested one too', async () => {
    const { steps, end } = recorder();
    let inner: Promise<Error | undefined> | undefined;
    const outer = failure(steps.run('agent', 'agent.act', 'check out', async () => {
      inner = failure(steps.run('locator', 'locator.tap', 'getByRole("button", "Pay")', never));
      await never();
    }));
    const reason = closed();
    steps.nameRunning(reason, cut);
    end.abort(reason);

    expect(await outer).toMatchObject({ code: 'CANCELLED', message: 'the session closed while agent.act "check out" was running' });
    expect(await inner).toMatchObject({ code: 'CANCELLED', message: 'the session closed while locator.tap "getByRole("button", "Pay")" was running' });
    expect((await outer)?.stack).toContain('step-name-running.test.ts');
    expect(steps.all().map((step) => step.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('names a step that has no label by its api alone', async () => {
    const { steps, end } = recorder();
    const back = failure(steps.run('app', 'app.back', '', never));
    const reason = closed();
    steps.nameRunning(reason, cut);
    end.abort(reason);
    expect((await back)?.message).toBe('the session closed while app.back was running');
  });

  it('leaves a step started after the abort with the reason itself', async () => {
    const { steps, end } = recorder();
    const reason = closed();
    steps.nameRunning(reason, cut);
    end.abort(reason);
    await expect(steps.run('app', 'app.open', '/', never)).rejects.toBe(reason);
  });

  it('keeps the failure of a step another abort reached first', async () => {
    const { steps, end } = recorder();
    const step = failure(steps.run('app', 'app.open', '/', never));
    const timeout = new E2EError('test', 'TEST_TIMEOUT', 'session timed out after 1000 ms');
    end.abort(timeout);
    steps.nameRunning(closed(), cut);
    expect(await step).toBe(timeout);
  });
});
