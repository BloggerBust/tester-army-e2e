/**
 * The patterns `route`, `unroute`, `waitForResponse`, and `waitForRequest`
 * accept: a URL pattern, optionally narrowed to one method, which
 * `url-glob.ts` reads the URL half of, and for the two waits a predicate.
 */

import { types } from 'node:util';
import {
  rejectUnknownKeys,
  TestError,
  toTextPattern,
  type TextMatch,
  type TextPattern,
} from '@e2e-dev/core/engine';
import { describe } from './support.ts';

/** A validated route pattern: one URL pattern, optionally narrowed to one HTTP method. */
export interface NormalizedRoutePattern {
  /** Uppercased HTTP method, or `undefined` when every method matches. */
  readonly method: string | undefined;
  readonly url: TextPattern;
}

/** An HTTP method token: RFC 9110's `method = token`, extension methods included. */
const HTTP_METHOD = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validates a route pattern: a string or `RegExp` as before, or
 * `{ method, url }` where `method` is one HTTP method and `url` is a
 * string or `RegExp` as `url-glob.ts` reads one. The method is normalized to uppercase. `api` names
 * the calling member in errors.
 */
export function toRoutePattern(api: string, pattern: unknown): NormalizedRoutePattern {
  return normalize(api, pattern, 'a string, RegExp, or { method, url }');
}

/**
 * Validates a `waitForResponse` or `waitForRequest` pattern: a predicate the
 * test wrote, returned as is for the wait to call with each candidate, or a
 * route pattern as `toRoutePattern` reads one.
 */
export function toWaitPattern<Predicate extends (candidate: never) => unknown>(
  api: string,
  pattern: string | RegExp | { readonly method: string; readonly url: string | RegExp } | Predicate,
): NormalizedRoutePattern | Predicate {
  if (typeof pattern === 'function') return pattern;
  return normalize(api, pattern, 'a string, RegExp, { method, url }, or a predicate function');
}

/** `toRoutePattern` with the accepted shapes its errors name. */
function normalize(api: string, pattern: unknown, shapes: string): NormalizedRoutePattern {
  if (typeof pattern === 'string' || types.isRegExp(pattern)) {
    return { method: undefined, url: toTextPattern(pattern as TextMatch) };
  }
  if (typeof pattern !== 'object' || pattern === null || Array.isArray(pattern)) {
    throw new TestError('INVALID_ARGUMENT', `${api} pattern must be ${shapes}; got ${describe(pattern)}`);
  }
  rejectUnknownKeys(`${api} pattern`, pattern, ['method', 'url'], 'INVALID_ARGUMENT');
  const { method, url } = pattern as { method?: unknown; url?: unknown };
  if (method === undefined && url === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${api} pattern must be ${shapes}; got ${describe(pattern)}`);
  }
  if (method === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${api} pattern requires method`);
  }
  if (typeof method !== 'string' || !HTTP_METHOD.test(method)) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} pattern method must be an HTTP method such as "POST"; got ${describe(method)}`,
    );
  }
  if (method.includes('*') || method.includes('|')) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} pattern method is one HTTP method; use a plain URL pattern to match every method`,
    );
  }
  if (url === undefined) {
    throw new TestError('INVALID_ARGUMENT', `${api} pattern requires url`);
  }
  if (typeof url !== 'string' && !types.isRegExp(url)) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `${api} pattern url must be a string or RegExp, got ${describe(url)}`,
    );
  }
  return { method: method.toUpperCase(), url: toTextPattern(url as TextMatch) };
}

/**
 * A route or URL pattern as steps name it: a string quoted, a RegExp as its
 * literal, a method-narrowed pattern as `POST` plus its URL pattern, a
 * predicate as `predicate`. Invalid
 * non-RegExp shapes render as a description because the label runs before the
 * call validates its arguments.
 */
export function patternLabel(pattern: unknown): string {
  if (typeof pattern === 'string') return JSON.stringify(pattern);
  // Never the function's source: a predicate may close over test data.
  if (typeof pattern === 'function') return 'predicate';
  if (types.isRegExp(pattern)) return String(pattern);
  if (typeof pattern === 'object' && pattern !== null && 'method' in pattern) {
    const method = (pattern as { method?: unknown }).method;
    const url = (pattern as { url?: unknown }).url;
    if (typeof method === 'string') {
      // One level only: a url that refers back to the pattern must not recurse
      // before the call validates it.
      return `${method.toUpperCase()} ${types.isRegExp(url) ? String(url) : describe(url)}`;
    }
  }
  return describe(pattern);
}

/** Matches a request method against the method half of a validated route pattern. */
export function routeMethodMatches(pattern: NormalizedRoutePattern, method: string): boolean {
  return pattern.method === undefined || pattern.method === method.toUpperCase();
}

/** Structural equality for route patterns, used by unroute. */
export function routePatternsEqual(a: NormalizedRoutePattern, b: NormalizedRoutePattern): boolean {
  if (a.method !== b.method) return false;
  if (a.url.kind === 'string' && b.url.kind === 'string') return a.url.value === b.url.value;
  if (a.url.kind === 'regexp' && b.url.kind === 'regexp') return a.url.source === b.url.source && a.url.flags === b.url.flags;
  return false;
}
