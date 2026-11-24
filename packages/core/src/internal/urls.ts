/** URL normalization and origin policy helpers. */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from './errors.ts';
import { testPattern } from './regexp.ts';
import { toTextPattern, withIgnoreCase } from './text.ts';

export interface NormalizedBaseUrl {
  /** Serialized base URL without trailing artifacts beyond the normalized path. */
  readonly href: string;
  readonly origin: string;
  readonly basePath: string;
}

/**
 * Parses and normalizes the app base URL. Rejects userinfo, query, and
 * fragment. WHATWG parsing handles IDNA ASCII hosts, dot segments, and
 * default-port removal. A URL without a scheme gets `https://`, or `http://`
 * for a loopback host, so `tester.army` and `localhost:3000` both work as-is.
 * A `file:` URL names one file on this machine (see `fileBase`).
 */
export function normalizeBaseUrl(raw: string): NormalizedBaseUrl {
  let url: URL;
  try {
    url = new URL(withScheme(raw));
  } catch {
    throw new ConfigurationError('INVALID_APP_URL', `invalid app URL: ${raw}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain userinfo');
  }
  if (url.search !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain a query');
  }
  if (url.hash !== '') {
    throw new ConfigurationError('INVALID_APP_URL', 'app URL must not contain a fragment');
  }
  if (url.protocol === 'file:') return fileBase(url, raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError('INVALID_APP_URL', `app URL must be http(s), or a file: URL of a file on this machine: ${raw}`);
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ConfigurationError(
      'INVALID_APP_URL',
      `plain HTTP is allowed only for loopback hosts: ${raw}`,
    );
  }
  if (url.port === '0' && !isLoopbackAddress(url.hostname)) {
    throw new ConfigurationError(
      'INVALID_APP_URL',
      `port 0 asks the run for a free port and takes only the loopback address the command will bind, 127.0.0.1 or [::1]; a name like localhost may resolve to another one: ${raw}`,
    );
  }
  return { href: url.href, origin: url.origin, basePath: url.pathname };
}

/**
 * A `file:` app URL: one file on this machine, which the browser opens
 * itself. A host is refused, since a share is another machine's file, and so
 * is a directory: a browser lists it with a link to its parent, and from
 * there to every file the user can read. The file may not exist when the
 * config loads; opening it checks again.
 */
function fileBase(url: URL, raw: string): NormalizedBaseUrl {
  if (url.hostname !== '') {
    throw new ConfigurationError('INVALID_APP_URL', `a file app URL names a file on this machine, with no host, such as file:///path/to/index.html: ${raw}`);
  }
  const base: NormalizedBaseUrl = { href: url.href, origin: FILE_ORIGIN, basePath: url.pathname };
  if (fileScope(url, base) !== 'inside') {
    throw new ConfigurationError('INVALID_APP_URL', `a file app URL names one file this machine can reach, not a directory, such as file:///path/to/index.html: ${raw}`);
  }
  return base;
}

/**
 * The origin a file app is given. `URL.origin` of a file is the opaque
 * `null`, which every `data:` and `blob:` URL shares; the bare scheme equals
 * no URL's origin, so nothing is ever mistaken for being on the app's.
 */
const FILE_ORIGIN = 'file://';

/**
 * Whether an app URL, as declared, names a file: the one reading of the
 * scheme, shared with `normalizeBaseUrl`, so `file:8443/report` stays the
 * host `file` on port 8443. An unparseable URL names none; `normalizeBaseUrl`
 * says why.
 */
export function namesFile(raw: string): boolean {
  const spelled = withScheme(raw);
  return URL.canParse(spelled) && new URL(spelled).protocol === 'file:';
}

/** True when the app is a file the browser opens from disk: it has no origin, port, or host. */
export function isFileBase(base: NormalizedBaseUrl): boolean {
  return base.origin === FILE_ORIGIN;
}

/**
 * The path a `file:` URL names on this machine, or undefined when it names
 * none: a host, or a form `fileURLToPath` refuses, such as an encoded path
 * separator, which a browser decodes into a path the URL's own segments do
 * not show.
 */
function localFile(url: URL): string | undefined {
  try {
    return url.hostname === '' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `file` with every symbolic link on the way resolved. A path that does not
 * exist yet resolves as far as it does exist, so a new file under a linked
 * directory is still placed where it would be created.
 */
function realPath(file: string): string {
  let existing = file;
  let rest = '';
  for (;;) {
    try {
      return path.join(realpathSync(existing), rest);
    } catch (cause) {
      const parent = path.dirname(existing);
      const missing = cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR');
      if (!missing || parent === existing) throw cause;
      rest = path.join(path.basename(existing), rest);
      existing = parent;
    }
  }
}

/**
 * Where a `file:` URL lies for a file app: `inside` for a file in the
 * directory of the app's file or below it, `directory` for a directory
 * there, `outside` for everything else. Paths are compared decoded and with
 * symbolic links resolved, so neither an encoded separator nor a link in the
 * directory leads out of it. A path this machine cannot resolve (a NUL, a
 * name too long, a directory it may not search) is `outside`: the rule
 * fails closed.
 */
function fileScope(url: URL, base: NormalizedBaseUrl): 'inside' | 'directory' | 'outside' {
  const file = localFile(url);
  const appFile = localFile(new URL(base.href));
  if (file === undefined || appFile === undefined) return 'outside';
  try {
    const target = realPath(file);
    const relative = path.relative(realPath(path.dirname(appFile)), target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return 'outside';
    const directory = relative === '' || url.pathname.endsWith('/') || statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
    return directory ? 'directory' : 'inside';
  } catch {
    return 'outside';
  }
}

/**
 * Why a file app must not show a `file:` location, or undefined when it may:
 * a file outside the directory of the app's file, or a directory. `what`
 * names what asked.
 */
function fileScopeProblem(url: URL, base: NormalizedBaseUrl, what: string): string | undefined {
  const scope = fileScope(url, base);
  if (scope === 'outside') return `${what} stays in the directory of the app's file: file://${url.pathname} is outside it`;
  if (scope === 'directory') return `${what} opens a file, not a directory: file://${url.pathname}`;
  return undefined;
}

/**
 * Why the screen at `location` is not one a file app may show, or undefined
 * when it is: a link or a script in a local page can take the browser to any
 * file the user can read, where a typed URL cannot. Every sink that keeps or
 * sends a screen on its own asks this: a model's observation
 * (`checkObservedLocation`), the trace's step screens, and the evidence of a
 * failure. Any other location, and any other app, passes.
 */
export function leftFileApp(location: string | undefined, base: NormalizedBaseUrl | undefined): string | undefined {
  if (location === undefined || base === undefined || !isFileBase(base) || !URL.canParse(location)) return undefined;
  const url = new URL(location);
  return url.protocol === 'file:' ? fileScopeProblem(url, base, 'a file app') : undefined;
}

/** Refuses the location an observation taken for a model was at when a file app has left the directory of its file; see `leftFileApp`. */
export function checkObservedLocation(location: string | undefined, base: NormalizedBaseUrl | undefined): void {
  const problem = leftFileApp(location, base);
  if (problem !== undefined) throw new ConfigurationError('POLICY_DENIED', problem);
}

/**
 * True for a literal loopback address, `127.x.x.x` or `[::1]`. A free port is
 * free on one address family only, so a port-0 URL must name the address the
 * command binds rather than a name that may resolve to either.
 */
function isLoopbackAddress(hostname: string): boolean {
  return hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/** True when the URL was declared with port 0: the run picks a free port on its address and substitutes it. */
export function requestsFreePort(base: NormalizedBaseUrl): boolean {
  return new URL(base.href).port === '0';
}

/** The base URL as a test reads it: `href` without its trailing slash, so `${baseUrl}/path` joins with one slash. */
export function baseUrlOf(base: NormalizedBaseUrl): string {
  return base.href.endsWith('/') ? base.href.slice(0, -1) : base.href;
}

/** The port the base URL is served on: the explicit one, else the scheme's default; none for a file. */
export function portOf(base: NormalizedBaseUrl): number | undefined {
  if (isFileBase(base)) return undefined;
  const url = new URL(base.href);
  if (url.port !== '') return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** The base URL re-serialized on another port; everything else is kept. */
export function withPort(base: NormalizedBaseUrl, port: number): NormalizedBaseUrl {
  const url = new URL(base.href);
  url.port = String(port);
  return { href: url.href, origin: url.origin, basePath: url.pathname };
}

/**
 * Prepends a scheme to a schemeless URL. `localhost:3000` parses as scheme
 * `localhost:` under WHATWG rules, so a `scheme:` prefix counts as explicit
 * only when what follows the colon is not a port (`file:/tmp/app` stays a
 * file URL and is rejected downstream; `localhost:3000/app` is a host). The
 * loopback check runs on the host the string would have under a scheme.
 */
function withScheme(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(raw)) return raw;
  let probe: URL;
  try {
    probe = new URL(`https://${raw}`);
  } catch {
    return raw;
  }
  return `${isLoopbackHost(probe.hostname) ? 'http' : 'https'}://${raw}`;
}

/** True for loopback hosts where plain HTTP is allowed. */
/** `url` without userinfo, query, or fragment, any of which may carry a credential: safe to print. */
export function printableUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

// A final DNS root dot does not change a hostname's reserved-domain status.
// Keep the URL itself unchanged so origin serialization remains WHATWG-based.
const withoutRootDot = (hostname: string): string => hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

export function isLoopbackHost(hostname: string): boolean {
  const host = withoutRootDot(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '[::1]') return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** True when environment may default to `test` (loopback, .localhost, .test hosts). */
export function isImplicitTestHost(hostname: string): boolean {
  return isLoopbackHost(hostname) || withoutRootDot(hostname).endsWith('.test');
}

const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:']);

/** The one non-http(s) page navigation opens: empty, with no local or inline content. */
const BLANK_PAGE = 'about:blank';

/**
 * Resolves a navigation URL against the base and refuses every scheme but
 * http(s), except the exact `about:blank`. Returns the absolute URL string.
 * Any http(s) origin is admitted: a click can reach one just as well, so a
 * gate on typed navigation alone would guard nothing. The rule is an
 * allowlist because a browser wraps and nests schemes (`view-source:file:`,
 * `blob:`, `filesystem:`), and a list of forbidden ones misses the wrapper.
 *
 * `file:` passes only on a target whose app is itself a file, and only for
 * a file in that file's directory or below it, never a directory. The agent
 * names navigation URLs too, and a page can tell it to: without the bound, a
 * local page could have it open any file the user can read and then carry
 * what it read to an http(s) address. `checkObservedLocation` holds the same
 * bound over where the page itself goes.
 */
export function resolveNavigationUrl(input: string, base: NormalizedBaseUrl | undefined): { url: string } {
  let url: URL;
  try {
    url = new URL(input, base?.href);
  } catch {
    // A relative reference has nothing to resolve against on a target whose
    // target declares no URL; that is a missing URL, not a malformed one.
    if (base === undefined && !URL.canParse(input)) {
      throw new ConfigurationError(
        'APP_URL_REQUIRED',
        `navigation to "${input}" needs an app URL; the target declares no app.url`,
      );
    }
    throw new ConfigurationError('POLICY_DENIED', `malformed URL: ${input}`);
  }
  if (url.protocol === 'file:' && base !== undefined && isFileBase(base)) {
    const problem = fileScopeProblem(url, base, 'file navigation');
    if (problem !== undefined) throw new ConfigurationError('POLICY_DENIED', problem);
    return { url: url.href };
  }
  if (!NAVIGABLE_PROTOCOLS.has(url.protocol) && url.href !== BLANK_PAGE) {
    throw new ConfigurationError('POLICY_DENIED', `forbidden URL scheme: ${url.protocol}`);
  }
  return { url: url.href };
}

/**
 * The site a hostname belongs to: its registrable domain, approximated
 * without a public suffix list as the last two labels, or the last three
 * when the last is a two-letter country code and the one before it a short
 * second-level label (`example.co.uk`, `shop.com.au`). An IP literal or a
 * single-label host such as `localhost` is a site of its own. Where the
 * approximation errs it errs narrow, except on shared hosting suffixes such
 * as `vercel.app`, which it reads as one site.
 */
export function siteOf(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const keep = tld.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/**
 * True when a URL's host is on `site` as `siteOf` reads it: the rule for
 * which child frames an observation reads. An unparseable URL is off every
 * site.
 */
export function sameSite(url: string | URL, site: string): boolean {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    return siteOf(parsed.hostname) === site;
  } catch {
    return false;
  }
}

/**
 * Compares a current URL to an expected string/regexp.
 * Relative expected strings resolve against the base URL; string comparison is
 * exact after WHATWG serialization; regexps test the complete serialized URL.
 * Anything else is `INVALID_ARGUMENT`, the `toTextPattern` rule.
 * `ignoreCase` is Playwright's: `true` compares a string case-insensitively
 * and adds the `i` flag to a regexp, `false` removes it.
 */
export function urlMatches(
  current: string,
  expected: string | RegExp,
  baseHref: string,
  ignoreCase?: boolean,
): boolean {
  const pattern = withIgnoreCase(toTextPattern(expected), ignoreCase);
  if (pattern.kind === 'regexp') {
    return testPattern(pattern.source, pattern.flags, serializeForComparison(current));
  }
  let expectedUrl: URL;
  try {
    expectedUrl = new URL(pattern.value, baseHref);
  } catch {
    return false;
  }
  const actual = serializeForComparison(current);
  return ignoreCase === true
    ? actual.toLowerCase() === expectedUrl.href.toLowerCase()
    : actual === expectedUrl.href;
}

function serializeForComparison(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}


/** The schemes a device link may not take: the ones that read local content or inline a document, and the browser wrappers that carry one inside. */
const REFUSED_LINK_SCHEMES: ReadonlySet<string> = new Set(['file:', 'data:', 'javascript:', 'view-source:', 'blob:', 'filesystem:']);

/**
 * Whether a link's scheme (`URL.protocol`, with its colon) is one no app
 * link may take. A device link is any app's custom scheme, so links are
 * checked against this list rather than the http(s) rule navigation follows.
 */
export function isRefusedLinkScheme(protocol: string): boolean {
  return REFUSED_LINK_SCHEMES.has(protocol.toLowerCase());
}
