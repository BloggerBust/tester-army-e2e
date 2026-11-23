/** Retries for `expect.poll` and `expect(fn).toPass()`. */

import { checkIntervals } from '@e2e-dev/core/lib/config/validate';
import { ConfigurationError, errorMessage, TestError } from '@e2e-dev/core/lib/internal/errors';
import { isPlainObject, rejectUnknownKeys } from '@e2e-dev/core/lib/internal/options';
import { abortError, cancelledError, Deadline, MAX_TIMER_MS, sleep, withAbort, withTimeout } from '@e2e-dev/core/lib/internal/time';
import { currentAttempt, type PublishedAttempt } from '@e2e-dev/core/lib/expect/attempt';
import { currentPollScope, pollRead, pollReadSignal } from '@e2e-dev/core/lib/expect/poll-scope';
import { isRuntimeSkip } from '../internal/skip.ts';

/** Frames kept for the line a poll was called on; the user's line is a few frames up. */
const CALL_STACK_FRAMES = 20;

/** Time for the phase timeout to take precedence if the retry reaches the deadline first. */
const PHASE_TIMEOUT_GRACE_MS = 50;

type RetryContext = Pick<PublishedAttempt, 'budget' | 'recordSecondaryError'>;

type Sample = { readonly value: unknown } | { readonly error: unknown };
type CutSample = { readonly cut: Deadline; readonly error?: unknown };
type FailedSample = { readonly last: string; readonly cause?: unknown };
type RetryResult = { readonly value: unknown } | FailedSample;

type RetryOptions = {
  readonly api: string;
  readonly label: string;
  readonly timeout: number;
  readonly intervals: readonly number[];
  readonly message: string | undefined;
  readonly noSample: string;
};

/** A read that outlived the deadline, as opposed to one that failed. */
const READ_HUNG = new Error();

/** One read, cut at the deadline and at the attempt signal; a hung read's outcome is dropped. */
async function sample(
  read: () => unknown,
  currentDeadline: () => Deadline,
  signal: AbortSignal | undefined,
): Promise<Sample | CutSample> {
  const cutoff = new AbortController();
  const readSignal = signal === undefined ? cutoff.signal : AbortSignal.any([signal, cutoff.signal]);
  const startedAt = Date.now();
  const start = performance.now();
  const work = pollRead(async (): Promise<Sample | CutSample> => {
    let result: Sample;
    try {
      result = { value: await read() };
    } catch (error) {
      result = { error };
    }
    // A sample counts if it settles within the time that remained when it started.
    const deadline = currentDeadline();
    const late = performance.now() - start > deadline.remaining(startedAt);
    if (late || 'error' in result) cutoff.abort();
    return late ? { cut: deadline, ...('error' in result ? result : {}) } : result;
  }, readSignal);
  const cancellable = signal === undefined ? work : withAbort(work, signal, cancelledError);
  for (;;) {
    const deadline = currentDeadline();
    try {
      return await withTimeout(cancellable, deadline.remaining(), () => READ_HUNG);
    } catch (error) {
      if (error !== READ_HUNG) throw error;
    }
    const current = currentDeadline();
    if (current !== deadline && !current.expired()) continue;
    cutoff.abort();
    return { cut: current };
  }
}

/** The stack at a poll's call, for the error that names it when its phase did not await it. */
function callStack(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Tracks a retry in the current phase and applies the phase deadline to reads and waits. */
export function retry(
  read: () => unknown,
  evaluate: (result: Sample) => RetryResult,
  options: RetryOptions,
  context: RetryContext | undefined,
): Promise<unknown> {
  const scope = currentPollScope() ?? currentAttempt()?.polls;

  const run = async (scopeSignal?: AbortSignal): Promise<unknown> => {
    const { api, label, timeout, intervals, message, noSample } = options;
    const budget = context?.budget;
    const phaseSignal = budget?.signal;
    // The phase that started the poll cancels it when it returns without
    // awaiting it, so the poll can never fail whatever runs after.
    const signals = [phaseSignal, scopeSignal, pollReadSignal()].filter((signal) => signal !== undefined);
    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);
    if (signal?.aborted) throw abortError(signal, cancelledError);

    const startedAt = Date.now();
    const own = timeout === 0 ? undefined : new Deadline(timeout, startedAt);
    // Inside an attempt the poll ends with the phase it runs in (the test
    // deadline in the body, the hook's cleanup budget in afterEach) and stops
    // the moment the attempt is cancelled, so a timed-out test never keeps
    // reading through teardown. A timeout of 0 sets no deadline of its own.
    const initial = own ?? budget?.deadline;
    if (initial === undefined) {
      throw new ConfigurationError('INVALID_CONFIG', `${api} timeout 0 waits for the test deadline, so it runs only inside a test or hook; pass a positive timeout`);
    }
    /**
     * The poll's own deadline capped by its phase's. A poll without one of its
     * own (`timeout: 0`) waits for the phase's, so it needs a phase to bound it.
     */
    const currentDeadline = (): Deadline => {
      const phase = budget?.deadline;
      return own !== undefined && phase !== undefined ? Deadline.min(own, phase) : phase ?? initial;
    };
    let last: FailedSample | undefined;
    let index = 0;
    let interval: number | undefined;

    const assertionFailure = (deadline: Deadline, endedAt: number): TestError => {
      const ending = deadline === own
        ? `timed out after ${timeout} ms`
        : `stopped at the attempt deadline after ${endedAt - startedAt} ms`;
      return new TestError(
        'ASSERTION_FAILED',
        [`${label} ${ending}`, ...(message === undefined ? [] : [message]), `last: ${last?.last ?? noSample}`].join('\n'),
        { cause: last?.cause },
      );
    };

    let end: { readonly deadline: Deadline; readonly at: number } | undefined;
    try {
      for (;;) {
        let deadline = currentDeadline();
        if (signal?.aborted) throw abortError(signal, cancelledError);
        if (!deadline.expired()) {
          const result = await sample(read, currentDeadline, signal);
          if (signal?.aborted) throw abortError(signal, cancelledError);
          if ('error' in result && isRuntimeSkip(result.error)) throw result.error;
          if ('cut' in result) {
            if ('error' in result) last = { last: errorMessage(result.error), cause: result.error };
            deadline = currentDeadline();
            if (deadline !== result.cut) continue;
          } else {
            const outcome = evaluate(result);
            if ('value' in outcome) return outcome.value;
            last = outcome;
            deadline = currentDeadline();
            interval = intervals[index++] ?? interval;
            const pause = interval ?? 0;
            const remaining = deadline.remaining();
            if (remaining > 0) await sleep(Math.min(pause, remaining), signal);
            if (pause < remaining || currentDeadline() !== deadline) continue;
          }
        }
        if (signal?.aborted) throw abortError(signal, cancelledError);
        end = { deadline, at: Date.now() };
        if (deadline === own) break;
        await sleep(PHASE_TIMEOUT_GRACE_MS, signal);
        if (currentDeadline() === deadline) break;
      }
    } catch (error) {
      const deadline = currentDeadline();
      if (deadline !== own && deadline.expired() && phaseSignal?.aborted === true && last !== undefined) {
        context?.recordSecondaryError?.(assertionFailure(deadline, end?.deadline === deadline ? end.at : Date.now()));
      }
      throw error;
    }
    throw assertionFailure(end.deadline, end.at);
  };

  return scope === undefined ? run() : scope.track(options.label, callStack(), run);
}

/** A malformed option would poll forever; it is refused before the first read. */
export function checkOptions(api: string, options: unknown): void {
  if (!isPlainObject(options)) {
    throw new ConfigurationError('INVALID_CONFIG', `${api} options must be a plain object`);
  }
  const poll = api === 'expect.poll';
  rejectUnknownKeys(`${api} options`, options, poll ? ['timeout', 'interval', 'intervals', 'message'] : ['timeout', 'intervals']);
  const { timeout, interval, intervals } = options;
  if (timeout !== undefined && !(typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${api} timeout must be a finite number of milliseconds, 0 or more; got ${String(timeout)}`,
    );
  }
  if (timeout !== undefined && timeout > MAX_TIMER_MS) {
    throw new ConfigurationError('INVALID_CONFIG', `${api} timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${timeout}`);
  }
  if (interval !== undefined) {
    if (intervals !== undefined) {
      throw new ConfigurationError('INVALID_CONFIG', 'expect.poll cannot take both interval and intervals');
    }
    if (!(typeof interval === 'number' && Number.isFinite(interval) && interval > 0)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `expect.poll interval must be a finite number of milliseconds above 0; got ${String(interval)}`,
      );
    }
  }
  checkIntervals(`${api} intervals`, intervals);
}
