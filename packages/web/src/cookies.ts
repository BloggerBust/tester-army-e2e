/**
 * The cookies `browser.setCookies` takes, checked before the URL rule or the
 * browser sees them. Tests run as JavaScript, so the `Cookie` type alone is no
 * guard, and a cookie the browser would refuse is the test's mistake, not the
 * engine's.
 */

import { domainToUnicode } from 'node:url';
import { ConfigurationError, rejectUnknownKeys, TestError } from '@e2e-dev/core/engine';
import type { Cookie } from './browser.ts';
import { describe } from './support.ts';

const COOKIE_KEYS = ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] as const;
const SAME_SITE = ['Strict', 'Lax', 'None'] as const;
/** The latest `expires` Playwright takes: the end of the year 9999, in seconds. */
const MAX_EXPIRES = 253_402_300_799;

/** Resolves a cookie URL under the harness's URL rule; only http(s) holds cookies. */
export function resolveCookieUrl(url: string, resolveUrl: (url: string) => string): string {
  const target = resolveUrl(url);
  if (!/^https?:/.test(target)) {
    throw new ConfigurationError('POLICY_DENIED', `cookie URL must be http(s): ${target}`);
  }
  return target;
}

/** The absolute URLs `browser.cookies` filters by, or `undefined` for no filter. */
export function resolveCookieUrls(urls: unknown, resolveUrl: (url: string) => string): string[] | undefined {
  if (urls === undefined) return undefined;
  const list: readonly unknown[] = Array.isArray(urls) ? urls : [urls];
  return list.map((url) => {
    if (typeof url !== 'string') {
      throw new TestError('INVALID_ARGUMENT', `browser.cookies takes a URL or an array of URLs, got ${describe(url)}`);
    }
    return resolveCookieUrl(url, resolveUrl);
  });
}

/** The step label of a `browser.cookies` call: the URLs as the test wrote them. */
export function cookieUrlsLabel(urls?: unknown): string {
  if (typeof urls === 'string') return urls;
  return Array.isArray(urls) ? urls.filter((url) => typeof url === 'string').join(', ') : '';
}

/** Throws `INVALID_ARGUMENT` naming the first field the `Cookie` type does not allow. */
export function validateCookies(cookies: unknown): asserts cookies is readonly Cookie[] {
  if (!Array.isArray(cookies)) {
    throw new TestError('INVALID_ARGUMENT', `browser.setCookies takes an array of cookies, got ${describe(cookies)}`);
  }
  for (const [index, cookie] of cookies.entries()) {
    const label = `browser.setCookies cookies[${index}]`;
    if (typeof cookie !== 'object' || cookie === null || Array.isArray(cookie)) {
      throw new TestError('INVALID_ARGUMENT', `${label} must be an object, got ${describe(cookie)}`);
    }
    rejectUnknownKeys(label, cookie, COOKIE_KEYS, 'INVALID_ARGUMENT');
    const problem = cookieProblem(cookie);
    if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', `${label} ${problem}`);
  }
}

function cookieProblem(cookie: object): string | undefined {
  const field = (key: (typeof COOKIE_KEYS)[number]): unknown => Reflect.get(cookie, key);
  for (const key of ['name', 'value'] as const) {
    if (typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  for (const key of ['url', 'path'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'string') return `${key} must be a string, got ${describe(field(key))}`;
  }
  const domain = field('domain');
  if (domain !== undefined && (typeof domain !== 'string' || !isHostName(domain))) {
    return `domain must be a host name like "example.com" or ".example.com", got ${describe(domain)}`;
  }
  if (field('url') !== undefined && (domain !== undefined || field('path') !== undefined)) {
    return 'takes url, or domain with an optional path, not both';
  }
  if (field('url') === undefined && domain === undefined) return 'needs a url, or a domain with an optional path';
  const expires = field('expires');
  if (expires !== undefined && !isExpiry(expires)) {
    return `expires must be a Unix timestamp in seconds (not milliseconds), got ${describe(expires)}`;
  }
  for (const key of ['httpOnly', 'secure'] as const) {
    if (field(key) !== undefined && typeof field(key) !== 'boolean') return `${key} must be a boolean, got ${describe(field(key))}`;
  }
  const sameSite = field('sameSite');
  if (sameSite !== undefined && !(SAME_SITE as readonly unknown[]).includes(sameSite)) {
    return `sameSite must be "Strict", "Lax", or "None", got ${describe(sameSite)}`;
  }
  return undefined;
}

/** Seconds from 0 through the end of the year 9999, or the `-1` Playwright reads as a session cookie. */
function isExpiry(expires: unknown): boolean {
  return typeof expires === 'number' && (expires === -1 || (expires >= 0 && expires <= MAX_EXPIRES));
}

/**
 * Whether `domain`, less a leading dot, parses back as only that host in the
 * origin `setCookies` checks it under, changed at most in case or to punycode,
 * with no empty label but a trailing dot's. A host the parser rewrites
 * (`1.2.3` to `1.2.0.3`, `%41.com` to `a.com`) would put the URL rule on
 * another host than the cookie's.
 */
function isHostName(domain: string): boolean {
  const host = domain.replace(/^\./, '');
  if (!URL.canParse(`http://${host}`)) return false;
  const url = new URL(`http://${host}`);
  const written = host.toLowerCase();
  const labels = url.hostname.replace(/\.$/, '').split('.');
  return (
    !labels.includes('') &&
    (url.hostname === written || domainToUnicode(url.hostname) === written)
  );
}
