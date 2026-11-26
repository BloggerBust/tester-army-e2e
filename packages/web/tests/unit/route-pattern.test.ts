import { describe, expect, it } from 'vitest';
import {
  patternLabel,
  routeMethodMatches,
  routePatternsEqual,
  toRoutePattern,
  toWaitPattern,
} from '../../src/route-pattern.ts';
import { urlPattern } from '../../src/url-glob.ts';

/** Whether a validated pattern's URL half matches, as `route` and `waitForResponse` read it. */
function routeUrlMatches(pattern: ReturnType<typeof toRoutePattern>, url: string): boolean {
  return urlPattern(pattern.url, () => 'http://x.test/').matches(url);
}

describe('routeUrlMatches and routeMethodMatches', () => {
  it('supports regexp wire patterns', () => {
    expect(
      routeUrlMatches(toRoutePattern('route', /api\/\w+$/), 'http://x.test/api/flags'),
    ).toBe(true);
  });

  it('supports a method-narrowed regexp url', () => {
    const post = toRoutePattern('route', { method: 'POST', url: /api\/\w+$/ });
    expect(routeUrlMatches(post, 'http://x.test/api/flags')).toBe(true);
    expect(routeUrlMatches(post, 'http://x.test/api-flags')).toBe(false);
    expect(routeMethodMatches(post, 'POST')).toBe(true);
    expect(routeMethodMatches(post, 'GET')).toBe(false);
  });

  it('matches a method case-insensitively, and any method without one', () => {
    const post = toRoutePattern('route', { method: 'post', url: '**/api/flags' });
    expect(routeUrlMatches(post, 'http://x.test/api/flags')).toBe(true);
    expect(routeMethodMatches(post, 'POST')).toBe(true);
    expect(routeMethodMatches(post, 'post')).toBe(true);
    expect(routeMethodMatches(post, 'GET')).toBe(false);
    const any = toRoutePattern('route', '**/api/flags');
    expect(routeUrlMatches(any, 'http://x.test/api/flags')).toBe(true);
    expect(routeMethodMatches(any, 'DELETE')).toBe(true);
  });

  it('accepts a class instance with method and url', () => {
    class Matcher {
      readonly method = 'POST';
      readonly url = '**/api/flags';
    }
    const matcher = toRoutePattern('route', new Matcher());
    expect(routeUrlMatches(matcher, 'http://x.test/api/flags')).toBe(true);
    expect(routeMethodMatches(matcher, 'POST')).toBe(true);
  });

  it('rejects a malformed method-narrowed pattern', () => {
    expect(() => toRoutePattern('browser.route', { method: 'PO ST', url: '**/a' })).toThrow('must be an HTTP method');
    expect(() => toRoutePattern('browser.route', { url: '**/a' })).toThrow('requires method');
    expect(() => toRoutePattern('browser.route', { method: 'POST' })).toThrow('requires url');
    expect(() => toRoutePattern('browser.route', { method: 'POST', url: '**/a', times: 1 })).toThrow('has unknown key "times"');
    expect(() => toRoutePattern('browser.route', ['POST', '**/a'])).toThrow('must be a string, RegExp, or { method, url }');
    expect(() => toRoutePattern('browser.route', () => true)).toThrow('must be a string, RegExp, or { method, url }; got function');
    expect(() => toRoutePattern('browser.route', {})).toThrow('must be a string, RegExp, or { method, url }; got an object');
    expect(() => toRoutePattern('browser.route', new URL('https://x.test/api'))).toThrow('must be a string, RegExp, or { method, url }; got an object');
    expect(() => toRoutePattern('browser.route', { method: ['GET'], url: '**/a' })).toThrow('got an array');
    expect(() => toRoutePattern('browser.route', null)).toThrow('got null');
    expect(() => toRoutePattern('browser.route', { method: '*', url: '**/a' })).toThrow('one HTTP method');
    expect(() => toRoutePattern('browser.route', { method: 'GET|POST', url: '**/a' })).toThrow('one HTTP method');
    expect(() => toRoutePattern('browser.route', { method: 'M-SEARCH', url: '**/a' })).not.toThrow();
  });
});

describe('toWaitPattern', () => {
  it('returns a predicate as is and validates every other pattern as a route pattern', () => {
    const predicate = (response: { status: number }) => response.status === 201;
    expect(toWaitPattern('browser.waitForResponse', predicate)).toBe(predicate);
    expect(toWaitPattern('browser.waitForRequest', { method: 'post', url: '**/a' })).toEqual(
      toRoutePattern('browser.route', { method: 'post', url: '**/a' }),
    );
  });

  it('names the predicate among the shapes it takes', () => {
    expect(() => toWaitPattern('browser.waitForRequest', 42 as unknown as string)).toThrow(
      'browser.waitForRequest pattern must be a string, RegExp, { method, url }, or a predicate function; got 42',
    );
  });
});

describe('patternLabel', () => {
  it('names a predicate without its source', () => {
    expect(patternLabel((response: { status: number }) => response.status === 201)).toBe('predicate');
  });

  it('names a string, a regexp, and a method-narrowed pattern', () => {
    expect(patternLabel('**/api/orders')).toBe('"**/api/orders"');
    expect(patternLabel(/api\/orders$/)).toBe('/api\\/orders$/');
    expect(patternLabel({ method: 'post', url: '**/api/orders' })).toBe('POST "**/api/orders"');
    expect(patternLabel({ method: 'POST', url: /orders$/ })).toBe('POST /orders$/');
  });

  it('never throws on a value without a usable toString', () => {
    expect(patternLabel(Object.create(null))).toBe('an object');
    expect(patternLabel({ method: 'POST', url: Object.create(null) })).toBe('POST an object');
    expect(patternLabel({ method: 'POST' })).toBe('POST undefined');
    expect(patternLabel(null)).toBe('null');
    expect(patternLabel({ method: 42, url: '**/a' })).toBe('an object');
  });

  it('formats a method-narrowed pattern one level only', () => {
    const cyclic: { method: string; url?: unknown } = { method: 'POST' };
    cyclic.url = cyclic;
    expect(patternLabel(cyclic)).toBe('POST an object');
  });
});

describe('routePatternsEqual', () => {
  it('compares string and regexp forms structurally', () => {
    expect(routePatternsEqual(toRoutePattern('unroute', '**/a'), toRoutePattern('unroute', '**/a'))).toBe(true);
    expect(routePatternsEqual(toRoutePattern('unroute', /a/i), toRoutePattern('unroute', /a/i))).toBe(true);
    expect(routePatternsEqual(toRoutePattern('unroute', /a/i), toRoutePattern('unroute', /a/g))).toBe(false);
    expect(routePatternsEqual(toRoutePattern('unroute', 'a'), toRoutePattern('unroute', /a/))).toBe(false);
  });

  it('compares methods too', () => {
    expect(routePatternsEqual(
      toRoutePattern('unroute', { method: 'POST', url: '**/a' }),
      toRoutePattern('unroute', { method: 'post', url: '**/a' }),
    )).toBe(true);
    expect(routePatternsEqual(
      toRoutePattern('unroute', { method: 'POST', url: /a/ }),
      toRoutePattern('unroute', { method: 'post', url: /a/ }),
    )).toBe(true);
    expect(routePatternsEqual(
      toRoutePattern('unroute', { method: 'POST', url: '**/a' }),
      toRoutePattern('unroute', '**/a'),
    )).toBe(false);
    expect(routePatternsEqual(
      toRoutePattern('unroute', { method: 'GET', url: '**/a' }),
      toRoutePattern('unroute', { method: 'POST', url: '**/a' }),
    )).toBe(false);
  });
});
