import { AsyncLocalStorage } from 'node:async_hooks';

type HeldTestToolCall = {
  readonly signal: AbortSignal;
  running: boolean;
  errorCode: string | undefined;
};

export const heldTestToolCallScope = new AsyncLocalStorage<HeldTestToolCall>();

/** Reports whether the current work belongs to an attached call that is still running. */
export function inHeldTestToolCall(): boolean {
  const call = heldTestToolCallScope.getStore();

  return call !== undefined && call.running && !call.signal.aborted;
}
