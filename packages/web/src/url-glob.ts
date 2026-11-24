/**
 * The web engine's one URL pattern grammar, Playwright's. `browser.waitForURL`,
 * `route`, `unroute`, and `waitForResponse` read every string as a URL glob,
 * so one with no wildcard matches that URL exactly, and a RegExp against the
 * full URL. `expect(browser).toHaveURL` compares a string exactly
 * (`urlMatches` in core): Playwright's `toHaveURL` never reads a glob, so only
 * these read one.
 */

import { TestError, type TextPattern } from '@e2e-dev/core/engine';

/** Schemes whose URLs Playwright never resolves against a base, so a glob that starts with one stays as written. */
const UNRESOLVED_GLOB_SCHEMES = ['about:', 'data:', 'chrome:', 'edge:', 'file:'];

/** A URL pattern compiled once against the base URL. */
export interface UrlPattern {
  /** Whether a URL matches the pattern. */
  readonly matches: (url: string) => boolean;
  /** The pattern as a failed wait prints it: a string resolved against the base, a RegExp as written. */
  readonly label: string;
}

/**
 * Compiles a `waitForURL`, `route`, `unroute`, or `waitForResponse` pattern as
 * Playwright's `urlMatches` does: a string is a URL glob, the empty string
 * matches any URL, and a RegExp tests the full URL. A string with no `*`, `{`,
 * `}`, or `\` matches the one URL it resolves to. `base` is read only for a
 * string that needs it, so a target with no app URL takes every other pattern.
 * A glob that nests a `{` or leaves one unmatched is `INVALID_ARGUMENT` here,
 * before it is resolved or anything is matched.
 */
export function urlPattern(expected: TextPattern, base: () => string): UrlPattern {
  if (expected.kind === 'regexp') {
    return {
      matches: (url) => new RegExp(expected.source, expected.flags).test(serialized(url)),
      label: String(new RegExp(expected.source, expected.flags)),
    };
  }
  if (expected.value === '') return { matches: () => true, label: '' };
  // Refuse a bad `{` in the glob as written, before resolving: `..` can drop the segment that holds it (`/{bad/../x`).
  urlGlobSource(expected.value);
  if (!/[*{}\\]/.test(expected.value)) {
    // The URL parser normalizes the whole string, query included, as it does the browser's URL, so the two compare as they are.
    const baseHref = baseFor(expected.value, base);
    const exact = URL.canParse(expected.value, baseHref) ? new URL(expected.value, baseHref).href : expected.value;
    return { matches: (url) => serialized(url) === exact, label: exact };
  }
  const glob = resolveUrlGlob(expected.value, base);
  const pattern = new RegExp(urlGlobSource(glob));
  return { matches: (url) => pattern.test(serialized(url)), label: glob };
}

/**
 * The expected URL as `toHaveURL` compares it: a string resolved against the
 * base, the way `urlMatches` resolves it, so it reads beside the absolute
 * observed URL. A string that does not parse, and a RegExp, print as written.
 */
export function describeExpectedUrl(expected: string | RegExp, baseHref: string): string {
  if (typeof expected !== 'string') return String(expected);
  try {
    return new URL(expected, baseHref).href;
  } catch {
    return expected;
  }
}

/**
 * Whether a glob's first segment is in a scheme's place: it ends in `:` and
 * holds no `?` or `#`, so `login?next=https:` is a relative path whose query
 * holds a URL.
 */
function inSchemePlace(segment: string): boolean {
  return segment.endsWith(':') && !/[?#]/.test(segment);
}

/** Whether a scheme segment is a pattern rather than a scheme: it holds a `*` or a `{`, as Playwright reads it. */
function isSchemePattern(segment: string): boolean {
  return segment.includes('*') || segment.includes('{');
}

/** The current URL as `urlMatches` compares it: serialized by the URL parser, else as given. */
function serialized(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Escapes one character for literal use inside a regexp source. */
function escapeRegexpChar(ch: string): string {
  return /[a-zA-Z0-9_-]/.test(ch) ? ch : `\\${ch}`;
}

/**
 * One literal glob character as a regexp source: printable ASCII as itself,
 * and anything else (non-ASCII text, a space) percent-encoded, as the URL
 * parser encodes it in the URL the browser reports. A lone surrogate, which
 * cannot be encoded, stays as written.
 */
function literalSource(ch: string): string {
  if (/^[\x21-\x7e]$/.test(ch)) return escapeRegexpChar(ch);
  let encoded: string;
  try {
    encoded = encodeURIComponent(ch);
  } catch {
    return escapeRegexpChar(ch);
  }
  return [...encoded].map(escapeRegexpChar).join('');
}

/**
 * The base a string resolves against, read only when the string needs one.
 * A real or globbed scheme and a full URL stand alone, while `a_b:/x` and
 * `login?next=https://...` are relative. `http:/x`, `http:x`, and a globbed
 * `http{,s}:/x` are relative to a base of that scheme, and the full URLs they
 * parse to on a target with no app URL.
 */
function baseFor(glob: string, base: () => string): string | undefined {
  const first = glob.split('/', 1)[0]!;
  const noAuthority = /^(?:https?|wss?|ftp):(?!\/\/)/i.test(glob)
    || (inSchemePlace(first) && isSchemePattern(first) && !glob.startsWith(`${first}//`));
  if (noAuthority) {
    try {
      return base();
    } catch {
      return undefined;
    }
  }
  const scheme = inSchemePlace(first) && (/^[a-z][a-z0-9+.-]*:$/i.test(first) || isSchemePattern(first));
  return scheme || URL.canParse(glob) ? undefined : base();
}

/**
 * Resolves a relative URL glob against the base URL, as Playwright's
 * `resolveGlobBase` does: each path segment that holds a glob character is
 * swapped for a placeholder the URL parser leaves alone, the rest resolves,
 * and the segments go back, lowercased where they landed in the origin (the
 * scheme and host match in any case). Unlike Playwright, which hides a `#`
 * in a placeholder and so lets a `..` after it eat a path segment, a fragment
 * is held behind its `#` like a query. A glob that starts with `*` matches any
 * origin and stays as written; so does one that starts with an unresolved
 * scheme, or does not parse against the base.
 */
function resolveUrlGlob(glob: string, base: () => string): string {
  if (glob.startsWith('*')) return glob;
  const baseHref = baseFor(glob, base);
  if (UNRESOLVED_GLOB_SCHEMES.some((scheme) => glob.startsWith(scheme))) return glob;
  // A placeholder prefix neither the glob nor the base holds, so restoring a segment never lands on the user's own text.
  let tag = '$_';
  while (glob.includes(tag) || baseHref?.includes(tag) === true) tag += '_';
  const originals = new Map<string, string>();
  const hold = (original: string, placeholder: string): string => {
    if (original === '') return '';
    originals.set(placeholder, original);
    return placeholder;
  };
  const relative = glob.split('/').map((segment, index) => {
    if (segment === '.' || segment === '..' || segment === '') return segment;
    if (index === 0 && inSchemePlace(segment)) return isSchemePattern(segment) ? hold(segment, 'http:') : segment;
    if (!/[*?{}\\]/.test(segment)) return segment;
    // The query or fragment is held behind its own `?` or `#`, so the URL parser still sees where the path ends
    // and a later `..` stays in the query or fragment instead of eating a path segment.
    const end = segment.search(/[?#]/);
    if (end === -1) return hold(segment, `${tag}${String(index)}_$`);
    const delimiter = segment[end]!;
    return hold(segment.slice(0, end), `${tag}${String(index)}_$`) + hold(segment.slice(end), `${delimiter}${tag}${String(index)}_$`);
  }).join('/');
  let url: URL;
  try {
    url = new URL(relative, baseHref);
  } catch {
    return glob;
  }
  let resolved = url.href;
  for (const [placeholder, original] of originals) {
    const segment = url.origin.includes(placeholder) ? original.toLowerCase() : original;
    resolved = resolved.replace(placeholder, () => segment);
  }
  return resolved;
}

/**
 * Compiles a URL glob to a regexp source matching the whole URL, in
 * Playwright's grammar: `*` matches within one path segment, `**` across `/`
 * (a `**` segment may also match none), `{a,b}` matches either, and `\`
 * escapes the next character. `?` and everything else is literal, so a query
 * string reads as written, and non-ASCII text and spaces match the URL
 * percent-encoded. A nested or unbalanced `{` is `INVALID_ARGUMENT`.
 */
function urlGlobSource(glob: string): string {
  const invalid = (problem: string): TestError =>
    new TestError('INVALID_ARGUMENT', `URL glob ${JSON.stringify(glob)} ${problem}`);
  /** The whole character (code point) at `index`, so an astral one is encoded as one. */
  const charAt = (index: number): string => String.fromCodePoint(glob.codePointAt(index)!);
  let source = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = charAt(i);
    if (ch === '\\' && i + 1 < glob.length) {
      const next = charAt(i + 1);
      source += literalSource(next);
      i += next.length;
      continue;
    }
    if (ch === '*') {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === '*') {
        stars += 1;
        i += 1;
      }
      if (stars === 1) {
        source += '([^/]*)';
      } else if (glob[i + 1] === '/') {
        source += before === '/' ? '((.+/)|)' : '(.*/)';
        i += 1;
      } else {
        source += '(.*)';
      }
      continue;
    }
    if (ch === '{') {
      if (inGroup) throw invalid("nests a '{'");
      inGroup = true;
      source += '(';
    } else if (ch === '}') {
      if (!inGroup) throw invalid("has an unmatched '}'");
      inGroup = false;
      source += ')';
    } else if (ch === ',' && inGroup) {
      source += '|';
    } else {
      source += literalSource(ch);
    }
    i += ch.length - 1;
  }
  if (inGroup) throw invalid("has an unmatched '{'");
  return `${source}$`;
}
