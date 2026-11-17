/** Route URL pattern grammar. */

import { TestError, type TextPattern, toTextPattern } from '@e2e-dev/core/engine';

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

const HOST_AND_PORT = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):(?:\d+(?=\/|$)|$)/i;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const PARTIAL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*$/;

/** Converts a route pattern and rejects common missing-scheme mistakes. */
export function parseRoutePattern(
  method: 'route' | 'unroute' | 'waitForResponse',
  pattern: Parameters<typeof toTextPattern>[0],
): TextPattern {
  const wire = toTextPattern(pattern);
  if (wire.kind !== 'string') return wire;
  const raw = wire.value.match(/^(?:\\[\s\S]?|[^\\*?])*/)?.[0] ?? '';
  const whole = raw.length === wire.value.length;
  const text = raw.replace(/\\([\s\S]?)/g, '$1');
  const accepted = SCHEME.test(text)
    ? !HOST_AND_PORT.test(text)
    : !whole && (text === '' || PARTIAL_SCHEME.test(text));
  if (accepted) return wire;
  const hint = wire.value.startsWith('/')
    ? `Use ${JSON.stringify(`**${wire.value}`)} to match that path on any origin, or a regular expression`
    : 'Use a glob on the full URL, such as "**/api/orders" or "http://localhost:3000/**", or a regular expression';
  throw new TestError(
    'INVALID_ARGUMENT',
    `browser.${method} pattern ${JSON.stringify(wire.value)} must match the full URL, including its scheme. ${hint}`,
  );
}
