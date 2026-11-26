/**
 * `browser.clock`: Playwright's page clock, driven through the attempt's
 * `BrowserContext.clock`. This module holds what the engine adds around it:
 * argument checks with Playwright's grammar, the step labels, the log of
 * calls a replacement context replays, and the classification of the
 * errors Playwright throws.
 */

import { types } from 'node:util';
import type { Clock } from 'playwright-core';
import { TestError } from '@e2e-dev/core/engine';
import { describe, isClassified, isPwTimeout, message, translatePwError } from './support.ts';

/** A point in time: epoch milliseconds, a string `Date` parses, or a `Date`. */
export type ClockTime = number | string | Date;

/** A span of time: milliseconds, or a `'ss'`, `'mm:ss'`, or `'hh:mm:ss'` string. */
export type ClockTicks = number | string;

/**
 * Controls time in the pages of the attempt, as Playwright's `page.clock`
 * does: `Date`, `performance`, timers, `requestAnimationFrame`, and
 * `requestIdleCallback` in every tab and frame, the ones the app opens
 * included, from the call on. A navigation keeps the clock; nothing outside
 * the page (the test's own timeouts, the harness's waits) follows it.
 */
export interface BrowserClock {
  /**
   * Replaces the page's time functions with fake ones that start at `time`
   * (default: now) and run on in real time until `pauseAt` or
   * `setFixedTime`. Every other method installs the clock first if needed,
   * starting at the Unix epoch, as Playwright's does.
   */
  install(options?: { time?: ClockTime }): Promise<void>;
  /** Jumps the clock ahead by `ticks`, firing each due timer at most once, as when a laptop wakes. */
  fastForward(ticks: ClockTicks): Promise<void>;
  /** Advances the clock by `ticks`, firing every timer due on the way. */
  runFor(ticks: ClockTicks): Promise<void>;
  /** Fast-forwards to `time` and pauses there: timers fire only through `runFor` and `fastForward`. */
  pauseAt(time: ClockTime): Promise<void>;
  /** Lets a paused clock run on in real time. */
  resume(): Promise<void>;
  /** Makes `Date.now()` and `new Date()` return `time` from now on, while timers keep running. */
  setFixedTime(time: ClockTime): Promise<void>;
  /** Sets the wall time to `time` without firing a timer, as when the system clock changes. */
  setSystemTime(time: ClockTime): Promise<void>;
}

/** One successful clock call with its argument resolved to milliseconds, as a replacement context replays it. */
export type ClockCall =
  | { readonly method: 'install' | 'pauseAt' | 'setFixedTime' | 'setSystemTime' | 'fastForward' | 'runFor'; readonly ms: number }
  | { readonly method: 'resume' };

/**
 * Playwright's clock as a page sees it: `builtins` keeps the native time
 * functions the fakes replaced, and `controller.now()` reads the clock.
 */
export interface ClockHost {
  readonly __pwClock?: {
    readonly builtins: Pick<Window, 'requestAnimationFrame' | 'setTimeout'>;
    readonly controller: { now(): number };
  };
}

/** Runs in a frame: the time its page clock reads, or undefined before the clock is installed there. */
export function readClockNow(): number | undefined {
  // oxlint-disable-next-line no-underscore-dangle -- Playwright's name for its page clock
  return (globalThis as ClockHost).__pwClock?.controller.now();
}

/** `pauseAt` to a time before the clock's current time: the test's argument, refused. */
export function pausedInThePast(label: string, cause?: unknown): TestError {
  return new TestError('INVALID_ARGUMENT', `${label}: the time is before the clock's current time`, cause === undefined ? undefined : { cause });
}

/**
 * Epoch milliseconds of `time`, or `INVALID_ARGUMENT`. Strings parse as
 * Playwright parses them (`new Date(string)` in the runner's process); an
 * empty string, which Playwright reads as 1970, is refused.
 */
export function clockTime(api: string, time: unknown): number {
  const ms = timeValue(time);
  if (ms === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${api} takes epoch milliseconds, a date string, or a valid Date, got ${describe(time)}`);
  }
  return ms;
}

/**
 * Milliseconds of `ticks`, or `INVALID_ARGUMENT`: a finite number of zero or
 * more, or Playwright's `'ss'`, `'mm:ss'`, `'hh:mm:ss'` with every field
 * under 60.
 */
export function clockTicks(api: string, ticks: unknown): number {
  const ms = ticksValue(ticks);
  if (ms === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${api} takes milliseconds of zero or more, or 'ss', 'mm:ss', or 'hh:mm:ss', got ${describe(ticks)}`);
  }
  return ms;
}

/** Epoch milliseconds of a time inside the range a `Date` holds (±8.64e15), or undefined. */
function timeValue(time: unknown): number | undefined {
  const parsed = typeof time === 'number' || (typeof time === 'string' && time.trim() !== '')
    ? new Date(time).getTime()
    : types.isDate(time) ? time.getTime() : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  // A number keeps its fraction, as Playwright passes it on.
  return typeof time === 'number' ? time : parsed;
}

const TICKS_PATTERN = /^(\d\d:){0,2}\d\d?$/;

function ticksValue(ticks: unknown): number | undefined {
  if (typeof ticks === 'number') return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
  if (typeof ticks !== 'string' || !TICKS_PATTERN.test(ticks)) return undefined;
  const fields = ticks.split(':').map(Number);
  if (fields.some((field) => field >= 60)) return undefined;
  return fields.reduce((seconds, field) => seconds * 60 + field, 0) * 1000;
}

/** The step label of a time argument, read defensively since the label runs before validation. */
export function clockTimeLabel(time: unknown): string {
  const ms = timeValue(time);
  return ms === undefined ? '' : new Date(ms).toISOString();
}

/** The step label of a ticks argument: milliseconds, or the string as given. */
export function clockTicksLabel(ticks: unknown): string {
  if (ticksValue(ticks) === undefined) return '';
  return typeof ticks === 'number' ? `${ticks}ms` : String(ticks);
}

/** The step label of `install`: its start time, if it names one. */
export function clockInstallLabel(options: unknown): string {
  if (typeof options !== 'object' || options === null) return '';
  return clockTimeLabel(Reflect.get(options, 'time'));
}

/** Runs one logged call on a context's clock. */
export function applyClockCall(clock: Clock, call: ClockCall): Promise<void> {
  switch (call.method) {
    case 'resume':
      return clock.resume();
    case 'install':
      return clock.install({ time: call.ms });
    default:
      return clock[call.method](call.ms);
  }
}

/**
 * A browser, context, page, or protocol session that went away under the
 * call, read at the start of the error's first line, where Playwright puts
 * its own errors: a page timer's error starts with its name (`Error: ...`)
 * and never matches, whatever its message says.
 */
const CLOSED_PATTERN = /^(?:Target page, context or browser has been closed|Target (?:closed|crashed)|Page crashed|Session closed|Connection closed|Browser closed|Browser has been disconnected|browser has disconnected|Protocol error \()/i;

/** The calls that run the page's timers while they move the clock. */
const RUNS_TIMERS: ReadonlySet<ClockCall['method']> = new Set(['runFor', 'fastForward', 'pauseAt']);

/**
 * Classifies a failed clock call. A timeout, a closed context, a crash, or a
 * lost connection is the engine's (`translatePwError`). `pauseAt` before the
 * clock's current time is the test's argument. Anything else a call that
 * runs timers reports was thrown by page code one of them ran:
 * `EVALUATE_FAILED`, as Playwright's own `runFor` rejects with it.
 */
export function translateClockError(cause: unknown, label: string, method: ClockCall['method']): Error {
  // The first line, without Playwright's `clock.runFor: ` prefix; the rest is the stack of its injected clock.
  const first = message(cause).split('\n', 1)[0]!.replace(/^clock\.\w+: /, '');
  if (isClassified(cause) || isPwTimeout(cause) || CLOSED_PATTERN.test(first) || !RUNS_TIMERS.has(method)) {
    return translatePwError(cause, label);
  }
  // Only pauseAt moves the clock to a time; runFor and fastForward take ticks, refused below zero.
  if (method === 'pauseAt' && first === 'Error: Cannot fast-forward to the past') return pausedInThePast(label, cause);
  return new TestError('EVALUATE_FAILED', `${label}: a page timer threw: ${first}`, { cause });
}
