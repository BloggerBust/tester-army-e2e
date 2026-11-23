/** Text normalization and matching rules. */

import { types } from 'node:util';
import type { TextPattern } from '../engine/contract.ts';
import type { TextMatch } from '../types.ts';
import { sanitizeText, TestError } from './errors.ts';
import { testPattern } from './regexp.ts';

export type { TextPattern };

/** Caps prose at `maxChars`, marking the cut with an ellipsis; a cut never splits a character in two (a surrogate pair). */
export function bound(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * Whether `bound(text, maxChars)` could equal what `bound` makes of a
 * different text: it cuts `text`, or `text` already ends like a cut.
 */
export function boundIsAmbiguous(text: string, maxChars: number): boolean {
  return text.length > maxChars || (text.length >= maxChars - 1 && text.endsWith('…'));
}

/**
 * Normalizes text by trimming leading/trailing whitespace and replacing every
 * nonempty run of Unicode whitespace with one ASCII space.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * Normalizes text that may carry control characters: sanitized first, then
 * whitespace-collapsed. The one-line form of screen text that reaches models,
 * trace descriptors, and terminals.
 */
export function collapseText(text: string): string {
  return normalizeText(sanitizeText(text));
}

/** Whether `value` is a `TextMatch`: a string, or a RegExp from any realm. */
export function isTextMatch(value: unknown): value is TextMatch {
  return typeof value === 'string' || types.isRegExp(value);
}

/**
 * Converts a public TextMatch plus options into the wire TextPattern form.
 * Anything but a string or a RegExp (from any realm), such as a
 * Playwright-style predicate, is `INVALID_ARGUMENT`: read as a regexp it would
 * have no source and match everything.
 */
export function toTextPattern(match: TextMatch, options?: { exact?: boolean }): TextPattern {
  if (typeof match === 'string') {
    return { kind: 'string', value: match, exact: options?.exact ?? true };
  }
  if (!types.isRegExp(match)) {
    throw new TestError('INVALID_ARGUMENT', `pattern must be a string or RegExp, got ${typeof match}`);
  }
  return { kind: 'regexp', source: match.source, flags: normalizeRegexpFlags(match.flags) };
}

/** Sorts and de-duplicates regexp flags into canonical d,g,i,m,s,u,v,y order. */
export function normalizeRegexpFlags(flags: string): string {
  const order = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];
  const present = new Set(flags.split(''));
  return order.filter((flag) => present.has(flag)).join('');
}

/** How a text matcher reads the two strings it compares. */
export interface TextComparison {
  /** `contains` accepts the expected string anywhere in the actual one; a regexp is tested the same way in both modes. */
  readonly mode: 'equals' | 'contains';
  /** Whether both sides are whitespace-normalized first. `false` compares the raw strings, as a form control's value is. */
  readonly normalize: boolean;
  /** Compares a string pattern case-insensitively. A RegExp reads case from its flags; `withIgnoreCase` sets them. */
  readonly ignoreCase?: boolean | undefined;
}

/** How `matchesText` reads both sides: whitespace-normalized, a string pattern compared whole. */
const DEFAULT_MATCH_COMPARISON: TextComparison = { mode: 'equals', normalize: true };

/**
 * Matches normalized text against a pattern. String matching is exact by
 * default; `exact: false` is case-insensitive substring matching. Regular
 * expressions use ECMAScript semantics with lastIndex reset before every match.
 */
export function matchesText(actual: string, pattern: TextPattern): boolean {
  return compareText(actual, pattern, DEFAULT_MATCH_COMPARISON);
}

/**
 * The one text-matching rule, compiled once for a pattern that is tested
 * against many strings (every node of a tree): the pattern side is
 * normalized and case-folded here, not on every call. `mode` applies only to
 * exact string patterns: regexps and case-insensitive substrings read the
 * same way in both. `normalize: false` leaves whitespace alone on both
 * sides, for a field the platform reports verbatim. The default reads as
 * `matchesText` does.
 */
export function compileTextMatcher(
  pattern: TextPattern,
  comparison: TextComparison = DEFAULT_MATCH_COMPARISON,
): (actual: string) => boolean {
  const read = comparison.normalize ? normalizeText : (text: string): string => text;
  if (pattern.kind === 'regexp') {
    const { source, flags } = pattern;
    return (actual) => testPattern(source, flags, read(actual));
  }
  if (!pattern.exact) {
    const needle = read(pattern.value).toLowerCase();
    return (actual) => read(actual).toLowerCase().includes(needle);
  }
  const fold = comparison.ignoreCase === true ? (text: string): string => text.toLowerCase() : (text: string): string => text;
  const expected = fold(read(pattern.value));
  return comparison.mode === 'equals'
    ? (actual) => fold(read(actual)) === expected
    : (actual) => fold(read(actual)).includes(expected);
}

/** `compileTextMatcher` for one comparison. */
export function compareText(actual: string, pattern: TextPattern, comparison: TextComparison): boolean {
  return compileTextMatcher(pattern, comparison)(actual);
}

/**
 * The pattern under Playwright's `ignoreCase`: `true` adds a RegExp's `i`
 * flag, `false` removes it, `undefined` keeps the flags it came with. A string
 * pattern is returned as it is; `compareText` folds its case.
 */
export function withIgnoreCase(pattern: TextPattern, ignoreCase: boolean | undefined): TextPattern {
  if (pattern.kind !== 'regexp' || ignoreCase === undefined) return pattern;
  const flags = pattern.flags.replace('i', '');
  return { ...pattern, flags: normalizeRegexpFlags(ignoreCase ? `${flags}i` : flags) };
}

/** Renders a pattern for diagnostics. */
export function describePattern(pattern: TextPattern): string {
  if (pattern.kind === 'string') return JSON.stringify(pattern.value);
  return `/${pattern.source}/${pattern.flags}`;
}
