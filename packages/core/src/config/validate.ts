/** Scalar validators shared by the config resolvers; one message per rule. */

import { ConfigurationError } from '../internal/errors.ts';
import { MAX_TIMER_MS } from '../internal/time.ts';
import type { PassOptions } from '../types.ts';

export const DEFAULT_PASS_OPTIONS: Readonly<Required<PassOptions>> = Object.freeze({
  timeout: 0,
  intervals: Object.freeze([100, 250, 500, 1000]),
});

/**
 * A positive safe integer, or undefined when the value is absent. Durations
 * name their unit, because `'30s'` and `30` are the two ways this key is
 * usually written wrong.
 */
export function positiveInt(
  value: number | undefined,
  label: string,
  unit?: 'milliseconds',
): number | undefined {
  return value === undefined ? undefined : requiredPositiveInt(value, label, unit);
}

/** Validates a required positive safe integer. */
function requiredPositiveInt(value: unknown, label: string, unit?: 'milliseconds'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    const expected = unit === undefined ? 'a positive safe integer' : `a positive safe integer of ${unit}`;
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be ${expected}, got ${describeValue(value)}`,
    );
  }
  return value;
}

/**
 * A positive duration in milliseconds no longer than a timer can wait, or
 * undefined when the value is absent: `setTimeout` fires a longer delay at once.
 */
export function timerMs(value: number | undefined, label: string): number | undefined {
  const ms = positiveInt(value, label, 'milliseconds');
  if (ms !== undefined && ms > MAX_TIMER_MS) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be at most ${MAX_TIMER_MS} milliseconds, got ${ms}`);
  }
  return ms;
}

/** Validates the pauses between reads or tries before the first read or try. */
export function checkIntervals(label: string, intervals: unknown): void {
  if (intervals === undefined) return;
  if (!Array.isArray(intervals) || intervals.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a non-empty array of milliseconds`);
  }
  for (const [index, entry] of intervals.entries()) {
    requiredPositiveInt(entry, `${label}[${index}]`, 'milliseconds');
  }
}

/** A value as the author wrote it, for messages that quote the offending input. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** A present value that is not a boolean is a config error naming the key. */
export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be a boolean, got ${describeValue(value)}`);
  }
  return value;
}

/** A safe integer within [min, max], or undefined when the value is absent. */
export function boundedInt(
  value: number | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${label} must be an integer from ${min} through ${max}`,
    );
  }
  return value;
}

/** An absolute http(s) URL, or undefined when the value is absent. */
export function httpUrl(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = typeof value === 'string' ? new URL(value) : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new ConfigurationError('INVALID_CONFIG', `${label} must be an http(s) URL`);
  }
  return value;
}
