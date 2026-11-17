/** Route URL pattern grammar. */

import { TestError, type TextPattern } from '@e2e-dev/core/engine';

/** Escapes one character for literal use inside a regexp source. */
function escapeRegexpChar(ch: string): string {
  return /[a-zA-Z0-9_-]/.test(ch) ? ch : `\\${ch}`;
}

/**
 * Compiles a string route pattern: `*` matches within one path segment, `**`
 * crosses `/`, `?` matches one character, `\` escapes the next character;
 * everything else is literal. Matches against the complete URL.
 */
export function compileRoutePattern(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1;
      const next = pattern[i];
      if (next !== undefined) source += escapeRegexpChar(next);
      continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        source += '.*';
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '.';
      continue;
    }
    source += escapeRegexpChar(ch);
  }
  return new RegExp(`${source}$`);
}

/** Matches a URL against a wire TextPattern (string grammar or ECMAScript regexp). */
export function routePatternMatches(pattern: TextPattern, url: string): boolean {
  if (pattern.kind === 'string') {
    return compileRoutePattern(pattern.value).test(url);
  }
  return new RegExp(pattern.source, pattern.flags).test(url);
}

/** Structural equality for route patterns, used by unroute. */
export function routePatternsEqual(a: TextPattern, b: TextPattern): boolean {
  if (a.kind === 'string' && b.kind === 'string') return a.value === b.value;
  if (a.kind === 'regexp' && b.kind === 'regexp') return a.source === b.source && a.flags === b.flags;
  return false;
}

/** Rejects path-only strings while allowing wildcards to match the scheme and host. */
export function assertRoutePatternCanMatchUrl(pattern: TextPattern): void {
  if (pattern.kind !== 'string') return;
  const literalPrefix = pattern.value.match(/^(?:\\[\s\S]?|[^\\*?])*/)?.[0] ?? '';
  const slash = literalPrefix.indexOf('/');
  const colon = literalPrefix.indexOf(':');
  const pathPrefix = slash !== -1 && (colon === -1 || slash < colon);
  const literalPath = literalPrefix.length === pattern.value.length && colon === -1;
  const pathGlob = !pattern.value.includes(':')
    && !pattern.value.includes('**')
    && (pattern.value.match(/[/?]/g)?.length ?? 0) < 2;
  if (pathPrefix || literalPath || pathGlob) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `browser.route pattern ${JSON.stringify(pattern.value)} is path-only, but route patterns are matched against full URLs. Use a glob such as '**/api/orders' or a regular expression`,
    );
  }
}
