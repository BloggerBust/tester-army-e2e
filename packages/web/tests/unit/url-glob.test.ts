import { TestError, toTextPattern } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import { urlPattern } from '../../src/url-glob.ts';

const BASE = 'http://localhost:3000/';

/** Whether `expected` matches `url`, as `waitForURL`, `route`, `unroute`, and `waitForResponse` read it. */
function matches(expected: string | RegExp, url: string, base = BASE): boolean {
  return urlPattern(toTextPattern(expected), () => base).matches(url);
}

describe('URL globs', () => {
  it('reads a string as a glob, resolved against the base URL', () => {
    expect(matches('**/checkout', 'http://localhost:3000/checkout')).toBe(true);
    expect(matches('**/checkout', 'https://shop.test/checkout')).toBe(true);
    expect(matches('/orders/*', 'http://localhost:3000/orders/42')).toBe(true);
    expect(matches('/orders/*', 'http://other.test/orders/42')).toBe(false);
    expect(matches('a/*', 'http://localhost:3000/a/b')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://shop.example.com/a')).toBe(true);
    expect(matches('https://*.example.com/**', 'https://example.com/a')).toBe(false);
  });

  it('keeps * in one segment, lets ** cross /, and reads {a,b} as either', () => {
    expect(matches('/orders/*', 'http://localhost:3000/orders/42/items')).toBe(false);
    expect(matches('/orders/**', 'http://localhost:3000/orders/42/items')).toBe(true);
    expect(matches('/a/**/b', 'http://localhost:3000/a/b')).toBe(true);
    expect(matches('/a/**/b', 'http://localhost:3000/a/x/y/b')).toBe(true);
    expect(matches('/{cart,checkout}', 'http://localhost:3000/cart')).toBe(true);
    expect(matches('/{cart,checkout}', 'http://localhost:3000/home')).toBe(false);
  });

  it('reads ? as a literal, the start of a query, which a later .. stays inside', () => {
    expect(matches('**/search?q=*', 'http://localhost:3000/search?q=shoes')).toBe(true);
    expect(matches('**/search?q=*', 'http://localhost:3000/searchXq=shoes')).toBe(false);
    expect(matches('**/search?q=?', 'http://localhost:3000/search?q=a')).toBe(false);
    expect(matches('**/v?', 'http://localhost:3000/v1')).toBe(false);
    expect(matches('/x*?q=1/../y', 'http://localhost:3000/xyz?q=1/../y')).toBe(true);
    expect(matches('/x*?q=1/../y', 'http://localhost:3000/y')).toBe(false);
  });

  it('keeps a fragment behind its #, so a later .. stays in the fragment and the host keeps its case rules', () => {
    expect(matches('/account#tab*/../orders', 'http://localhost:3000/account#tab1/../orders')).toBe(true);
    expect(matches('/account#tab*/../orders', 'http://localhost:3000/orders')).toBe(false);
    expect(matches('https://example.com#Tab*', 'https://example.com/#Tab1')).toBe(true);
    expect(matches('https://example.com#Tab*', 'https://example.com/#tab1')).toBe(false);
  });

  it('globs the scheme, matching it and the host in any case, and keeps the path in its case', () => {
    expect(matches('http{,s}://localhost:3000/a', 'http://localhost:3000/a')).toBe(true);
    expect(matches('http{,s}://localhost:3000/a', 'https://localhost:3000/a')).toBe(true);
    expect(matches('http{,s}://localhost:3000/a', 'ftp://localhost:3000/a')).toBe(false);
    expect(matches('https://*.EXAMPLE.COM/**', 'https://shop.example.com/a')).toBe(true);
    expect(matches('https://*.example.com/A*', 'https://shop.example.com/abc')).toBe(false);
  });

  it('resolves a globbed scheme with no // against the base, as Playwright does', () => {
    expect(matches('http{,s}:/orders', 'http://localhost:3000/orders')).toBe(true);
    expect(matches('http*:/orders', 'https://localhost:3000/orders')).toBe(true);
    expect(matches('http{,s}:/orders', 'http://orders/')).toBe(false);
    expect(matches('http{,s}:', 'https://localhost:3000/')).toBe(true);
  });

  it('leaves a glob that starts with about: unresolved, and reads an escaped * and other characters as themselves', () => {
    expect(matches('about:*', 'about:blank')).toBe(true);
    expect(matches('/a\\*b', 'http://localhost:3000/a*b')).toBe(true);
    expect(matches('/a\\*b', 'http://localhost:3000/axb')).toBe(false);
    expect(matches('**/a.b', 'http://localhost:3000/a.b')).toBe(true);
    expect(matches('**/a.b', 'http://localhost:3000/aXb')).toBe(false);
  });

  it('matches text and spaces in any glob the way the browser encodes them', () => {
    expect(matches('/検索/*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2/1')).toBe(true);
    expect(matches('/検索?q=*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2?q=1')).toBe(true);
    expect(matches('**/検索?q=*', 'http://localhost:3000/%E6%A4%9C%E7%B4%A2?q=1')).toBe(true);
    expect(matches('/search?q=café*', 'http://localhost:3000/search?q=caf%C3%A9-1')).toBe(true);
    expect(matches('/files/my file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/files/my file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/files/my%20file*', 'http://localhost:3000/files/my%20file.pdf')).toBe(true);
    expect(matches('**/😀*', 'http://localhost:3000/%F0%9F%98%80x')).toBe(true);
  });

  it('restores each glob segment to its own place when the glob or the base holds text like a placeholder', () => {
    expect(matches('/$_2_$/x*', 'http://localhost:3000/$_2_$/xyz')).toBe(true);
    expect(matches('/$_2_$/x*', 'http://localhost:3000/xyz/$_2_$')).toBe(false);
    expect(matches('x*', 'http://localhost:3000/$_0_$/xyz', 'http://localhost:3000/$_0_$/')).toBe(true);
  });

  it('matches a string with no wildcard exactly, resolved against the base', () => {
    expect(matches('/search?q=shoes', 'http://localhost:3000/search?q=shoes')).toBe(true);
    expect(matches('/search?q=s', 'http://localhost:3000/search?q=shoes')).toBe(false);
    expect(matches('/api/flags', 'http://localhost:3000/api/flags')).toBe(true);
    expect(matches('/api/flags', 'http://x.test/api/flags')).toBe(false);
  });

  it('resolves a relative string whose query or fragment holds a URL against the base', () => {
    expect(matches('classes?next=http://127.0.0.1/orders', 'http://localhost:3000/classes?next=http://127.0.0.1/orders')).toBe(true);
    expect(matches('login#next=https://x.test/a', 'http://localhost:3000/login#next=https://x.test/a')).toBe(true);
    expect(matches('x*?next=http://x.test/a', 'http://localhost:3000/x1?next=http://x.test/a')).toBe(true);
    expect(matches('login{,2}#next=https://x.test/*', 'http://localhost:3000/login2#next=https://x.test/a')).toBe(true);
    expect(matches('login?next=https://x.test/*', 'http://localhost:3000/login?next=https://x.test/a')).toBe(true);
    expect(matches('classes?next=http://127.0.0.1/orders', 'http://x.test/classes?next=http://127.0.0.1/orders')).toBe(false);
  });

  it('resolves a first segment that is not a real scheme, and a scheme with no //, against the base', () => {
    for (const path of ['a_b:/x', '1:/x', ':/x', 'a_b:']) {
      expect(matches(path, `http://localhost:3000/${path}`), path).toBe(true);
    }
    expect(matches('http:/x', 'http://localhost:3000/x')).toBe(true);
    expect(matches('http:x', 'http://localhost:3000/x')).toBe(true);
    expect(matches('http:/x', 'http://x/')).toBe(false);
    expect(urlPattern(toTextPattern('https:a/b'), () => 'https://app.test/').matches('https://app.test/a/b')).toBe(true);
    const noBase = (): string => {
      throw new TestError('APP_URL_REQUIRED', 'no app url');
    };
    expect(urlPattern(toTextPattern('http:/x'), noBase).matches('http://x/')).toBe(true);
    expect(() => urlPattern(toTextPattern('a_b:/x'), noBase)).toThrow(expect.objectContaining({ code: 'APP_URL_REQUIRED' }));
  });

  it('holds a globbed scheme while it normalizes the host and the path', () => {
    expect(matches('http{,s}://LOCALHOST:3000/a', 'https://localhost:3000/a')).toBe(true);
    expect(matches('http{,s}://localhost:3000/a/../b', 'https://localhost:3000/b')).toBe(true);
  });

  it('tests a RegExp against the full URL', () => {
    expect(matches(/\/orders\/\d+$/, 'http://localhost:3000/orders/7')).toBe(true);
    expect(matches(/api\/\w+$/, 'http://x.test/api/flags')).toBe(true);
    expect(matches(/api\/\w+$/, 'http://x.test/api/a/b')).toBe(false);
  });

  it('reads every string as Playwright does: an escape in one with no wildcard, and the empty string as any URL', () => {
    expect(matches('/a\\.b', 'http://localhost:3000/a.b')).toBe(true);
    expect(matches('', 'http://localhost:3000/orders/7')).toBe(true);
    expect(matches('', 'about:blank')).toBe(true);
  });

  it('normalizes an exact string whole, query included, as the browser reports the URL', () => {
    expect(matches("/search?q=O'Neil", 'http://localhost:3000/search?q=O%27Neil')).toBe(true);
    expect(matches("https://x.test/a b?q=O'Neil", 'https://x.test/a%20b?q=O%27Neil')).toBe(true);
    expect(matches("/search?q=O'Neil", 'http://localhost:3000/search?q=Other')).toBe(false);
    expect(matches('data:text/html,hello world', 'data:text/html,hello world')).toBe(true);
  });

  it('reads the base only for a pattern that needs one, so a target with no app URL takes the rest', () => {
    const noBase = (): string => {
      throw new TestError('APP_URL_REQUIRED', 'no app url');
    };
    for (const pattern of ['https://x.test/a', 'https://*.x.test/**', 'http{,s}://x.test/a', 'http://localhost:3000**', 'http{,s}:/a', '**/a', 'about:blank', '', /a$/]) {
      expect(() => urlPattern(toTextPattern(pattern), noBase), String(pattern)).not.toThrow();
    }
    expect(urlPattern(toTextPattern('https://x.test/a'), noBase).matches('https://x.test/a')).toBe(true);
    for (const pattern of ['/a', 'a/*', 'x*?next=http://x.test/a']) {
      expect(() => urlPattern(toTextPattern(pattern), noBase), pattern).toThrow(expect.objectContaining({ code: 'APP_URL_REQUIRED' }));
    }
  });

  it('labels a string resolved against the base, and a RegExp as written', () => {
    expect(urlPattern(toTextPattern('**/checkout'), () => BASE).label).toBe('**/checkout');
    expect(urlPattern(toTextPattern('/orders'), () => BASE).label).toBe('http://localhost:3000/orders');
    expect(urlPattern(toTextPattern('/orders/*'), () => BASE).label).toBe('http://localhost:3000/orders/*');
    expect(urlPattern(toTextPattern(/orders/), () => BASE).label).toBe('/orders/');
  });

  it('refuses a nested or unbalanced { before anything is matched', () => {
    for (const glob of ['**/{a,{b}}', '**/{a,{b}', '**/{a', '**/a}']) {
      expect(() => urlPattern(toTextPattern(glob), () => BASE), glob).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
  });

  it('refuses a bad { in the glob as written, even where resolving would drop its segment or needs a base', () => {
    const noBase = (): string => {
      throw new TestError('APP_URL_REQUIRED', 'no app url');
    };
    for (const glob of ['/{bad/../orders', '/a}/../orders', '/{a,{b}/../orders']) {
      expect(() => urlPattern(toTextPattern(glob), () => BASE), glob).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    }
    expect(() => urlPattern(toTextPattern('/{bad'), noBase)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
