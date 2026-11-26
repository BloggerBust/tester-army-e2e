/**
 * Skipping a running test from its body: `test.skip(condition, reason)`.
 *
 * The signal is not an `E2EError`: a skip is a verdict, not a failure, and it
 * must never be classified, retried, or reported as one. The attempt runner
 * recognizes it by brand, not by class, because a test module loads in its
 * own realm and may resolve `e2e` to another copy of this package (the built
 * `dist` next to a runner on `src`, or a nested install).
 */

import { currentAttempt, type PublishedAttempt } from '@e2e-dev/core/lib/expect/attempt';
import type { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import type { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import { CollectionError, TestError } from '@e2e-dev/core/lib/internal/errors';
import type { SelfSkipCause } from '@e2e-dev/core/lib/run/records';

const runtimeSkipBrand: unique symbol = Symbol.for('e2e.runtimeSkip.v1');

class RuntimeSkip {
  readonly [runtimeSkipBrand] = true as const;
  readonly reason: string;
  readonly cause: SelfSkipCause;

  constructor(reason: string | undefined, cause: SelfSkipCause) {
    this.reason = reason === undefined || reason.trim() === '' ? 'skipped' : reason;
    this.cause = cause;
  }
}

/**
 * The skip cause a runtime skip reports: its own, or `explicit` for one with
 * none, which a copy of this package from before `test.fixme` throws.
 */
export function runtimeSkipCause(skip: CaughtRuntimeSkip): SelfSkipCause {
  return skip.cause === 'fixme' ? 'fixme' : 'explicit';
}

/**
 * A caught runtime skip, which may come from another copy of this package.
 * Its `cause` is not typed, so a reader goes through `runtimeSkipCause`.
 */
export interface CaughtRuntimeSkip {
  readonly reason: string;
  readonly cause?: unknown;
}

/** Whether `value` is a runtime skip thrown by any copy of this package. */
export function isRuntimeSkip(value: unknown): value is CaughtRuntimeSkip {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [runtimeSkipBrand]?: unknown })[runtimeSkipBrand] === true &&
    typeof (value as { reason?: unknown }).reason === 'string'
  );
}

/**
 * `test.step` for an attempt that records on `steps`. A skip thrown inside
 * a step leaves the step passed, and the step is cut with the phase it runs
 * in, since its body may wait on something no engine call cuts.
 */
export function attemptStep(steps: StepRecorder, budget: AttemptBudget): NonNullable<PublishedAttempt['step']> {
  return (title, body) => steps.group(title, body, { passesThrough: isRuntimeSkip, signal: budget.signal });
}

/** The three shapes `test.skip`, `test.fixme`, and `test.fail` accept, told apart before anything runs. */
export type ModifierCall =
  | { readonly kind: 'register'; readonly title: string; readonly fn: unknown }
  | { readonly kind: 'runtime'; readonly condition: boolean; readonly reason: string | undefined };

/**
 * `skip(title, fn)` registers a skipped test; `skip(condition, reason?)` and
 * `skip(reason?)` skip the running one, and `fixme` and `fail` take the same
 * shapes. A string alone is a reason, never a title: a registration always
 * carries its body.
 */
export function parseModifierCall(first: unknown, second: unknown): ModifierCall {
  if (typeof first === 'string' && typeof second === 'function') return { kind: 'register', title: first, fn: second };
  return {
    kind: 'runtime',
    condition: typeof first === 'boolean' ? first : true,
    reason: typeof first === 'string' ? first : typeof second === 'string' ? second : undefined,
  };
}

/**
 * The test APIs that skip the running test: the cause each reports, and the
 * collection form an outside-body call is pointed at.
 */
const RUNTIME_SKIP_APIS = {
  'test.skip': { cause: 'explicit', hint: 'to skip at collection, pass { skip: true } or a reason string as the test option' },
  'test.fixme': { cause: 'fixme', hint: 'to mark a test fixme at collection, register it with test.fixme(title, fn)' },
} as const satisfies Record<string, { readonly cause: SelfSkipCause; readonly hint: string }>;

/**
 * The skip reason of a `test.fixme` test: `fixme`, or `fixme: <reason>` when
 * a reason that is not blank is given.
 */
export function fixmeReason(reason?: string): string {
  return reason === undefined || reason.trim() === '' ? 'fixme' : `fixme: ${reason}`;
}

/**
 * Skips the running test when `condition` holds. `api` names the caller in
 * errors. Outside a body there is no running test, so the call is a
 * collection error pointing at the collection form; inside a setup test it is
 * a test error, because the sessions the setup declares are owed to their
 * consumers.
 */
export function skipRunningTest(
  api: keyof typeof RUNTIME_SKIP_APIS,
  condition: boolean,
  reason: string | undefined,
): void {
  const attempt = currentAttempt();
  if (attempt === undefined) {
    throw new CollectionError(
      `${api}(condition, reason) skips the running test and must be called inside a test body; ${RUNTIME_SKIP_APIS[api].hint}`,
    );
  }
  if (!condition) return;
  if (attempt.testKind === 'setup') {
    throw new TestError('INVALID_ARGUMENT', `${api}() cannot skip a setup test: the sessions it declares are owed to their consumers`);
  }
  throw new RuntimeSkip(reason, RUNTIME_SKIP_APIS[api].cause);
}
