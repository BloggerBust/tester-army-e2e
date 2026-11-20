/** Changing the running test's timeout from inside it: `test.setTimeout(timeout)`. */

import { currentAttempt } from '../expect/attempt.ts';
import { suiteHookBrand } from './brands.ts';
import { CollectionError, TestError } from './errors.ts';
import { realmSlot } from './realm-slot.ts';
import { MAX_TIMER_MS } from './time.ts';

/**
 * Code outside any test running now: a `beforeAll` or `afterAll` hook, or a
 * worker fixture's teardown. Only a `beforeAll` can have its timeout changed.
 */
export interface RunningSuiteHook {
  /** What runs, as a refusal names it: `an afterAll hook`. */
  readonly name: string;
  /** Moves the hook's timeout; false once the hook's timeout race settled. */
  readonly setTimeout?: (timeoutMs: number) => boolean;
}

/** On `globalThis`, as the published attempt is: test modules share nothing else with the runner. */
const suiteHookSlot = realmSlot<RunningSuiteHook>(suiteHookBrand);

/** Names `hook` as the running suite hook while `run` runs; one runs at a time per process. */
export async function inSuiteHook<T>(hook: RunningSuiteHook, run: () => Promise<T>): Promise<T> {
  suiteHookSlot.set(globalThis, hook);
  try {
    return await run();
  } finally {
    if (suiteHookSlot.get(globalThis) === hook) suiteHookSlot.delete(globalThis);
  }
}

/**
 * Gives the running test a timeout of `timeout` ms, counted from the start of
 * its attempt, the way a `{ timeout }` option is; in a `beforeAll` hook,
 * gives that hook a timeout counted from its start. Outside a test or hook
 * the call is a collection error pointing at the option. Where the attempt
 * or hook publishes no way to change it (teardown on `cleanupTimeout`, or a
 * hosted session that runs no e2e test), it is a test error.
 */
export function setRunningTestTimeout(timeout: unknown): void {
  const hook = suiteHookSlot.get(globalThis);
  const attempt = hook === undefined ? currentAttempt() : undefined;
  if (hook === undefined && attempt === undefined) {
    throw new CollectionError(
      'test.setTimeout(timeout) must be called inside a test body or a beforeEach or beforeAll hook; to set a test\'s timeout ahead of time, pass { timeout } as the test or describe option',
    );
  }
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new TestError('INVALID_ARGUMENT', `test.setTimeout() timeout must be a positive safe integer of milliseconds, got ${String(timeout)}`);
  }
  if (timeout > MAX_TIMER_MS) {
    throw new TestError('INVALID_ARGUMENT', `test.setTimeout() timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${timeout}`);
  }
  const set = hook === undefined ? attempt?.setTimeout : hook.setTimeout;
  if (set !== undefined) {
    if (!set(timeout)) {
      throw new TestError(
        'INVALID_ARGUMENT',
        'test.setTimeout() cannot change the timeout from code left running after its test or hook ended: await the work the test or hook starts',
      );
    }
  } else if (hook !== undefined) throw lateTimeoutError(hook.name);
  else {
    throw new TestError(
      'INVALID_ARGUMENT',
      'test.setTimeout() changes an e2e test\'s timeout, and a hosted session runs none: your test runner owns the test timeout, and host.openSession({ timeout }) sets the session deadline',
    );
  }
}

/** The error for a timeout change from teardown, which runs on `cleanupTimeout`. */
export function lateTimeoutError(from = 'an afterEach hook or a fixture teardown'): TestError {
  return new TestError(
    'INVALID_ARGUMENT',
    `test.setTimeout() cannot change the timeout from ${from}: teardown runs on cleanupTimeout, not the test timeout`,
  );
}
