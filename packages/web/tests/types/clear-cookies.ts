/**
 * Compile-time assertions for `browser.clearCookies`, the filters it takes,
 * each a string or RegExp, and for the URLs `browser.cookies` takes.
 */
import type { Browser, Cookie, CookieFilter } from '../../src/index.ts';

declare const browser: Browser;
const filter: CookieFilter = { name: /session/, domain: 'localhost', path: '/' };
void (browser.clearCookies(filter) satisfies Promise<void>);
void browser.clearCookies();
// @ts-expect-error filter values are strings or RegExps.
void browser.clearCookies({ name: 1 });
// @ts-expect-error `url` is not a filter.
void browser.clearCookies({ url: 'http://localhost' });

void (browser.cookies() satisfies Promise<Cookie[]>);
void browser.cookies('/account');
const urls: readonly string[] = ['https://example.com', '/account'];
void browser.cookies(urls);
// @ts-expect-error a URL is a string.
void browser.cookies(new URL('https://example.com'));
// @ts-expect-error cookies are filtered by URL, not by fields.
void browser.cookies({ name: 'session' });
