import { toTextPattern } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import {
  assertRoutePatternCanMatchUrl,
  compileRoutePattern,
  routePatternMatches,
  routePatternsEqual,
} from '../../src/route-pattern.ts';

function matches(pattern: string, url: string): boolean {
  return compileRoutePattern(pattern).test(url);
}

describe('route pattern grammar', () => {
  it('* matches within one path segment', () => {
    expect(matches('http://x.test/api/*', 'http://x.test/api/flags')).toBe(true);
    expect(matches('http://x.test/api/*', 'http://x.test/api/a/b')).toBe(false);
  });

  it('** crosses /', () => {
    expect(matches('**/api/flags', 'http://x.test/api/flags')).toBe(true);
    expect(matches('http://x.test/**', 'http://x.test/a/b/c')).toBe(true);
  });

  it('? matches one character', () => {
    expect(matches('http://x.test/v?', 'http://x.test/v1')).toBe(true);
    expect(matches('http://x.test/v?', 'http://x.test/v12')).toBe(false);
  });

  it('backslash escapes the next character', () => {
    expect(matches('http://x.test/a\\*b', 'http://x.test/a*b')).toBe(true);
    expect(matches('http://x.test/a\\*b', 'http://x.test/axb')).toBe(false);
  });

  it('other characters are literal, including dots', () => {
    expect(matches('http://x.test/a.b', 'http://x.test/a.b')).toBe(true);
    expect(matches('http://x.test/a.b', 'http://x.test/aXb')).toBe(false);
  });

  it('matches the complete URL, not a substring', () => {
    expect(matches('/api/flags', 'http://x.test/api/flags')).toBe(false);
  });
});

describe('routePatternMatches', () => {
  it('supports regexp wire patterns', () => {
    expect(
      routePatternMatches({ kind: 'regexp', source: 'api/\\w+$', flags: '' }, 'http://x.test/api/flags'),
    ).toBe(true);
  });
});

describe('routePatternsEqual', () => {
  it('compares string and regexp forms structurally', () => {
    expect(routePatternsEqual(toTextPattern('**/a'), toTextPattern('**/a'))).toBe(true);
    expect(routePatternsEqual(toTextPattern(/a/i), toTextPattern(/a/i))).toBe(true);
    expect(routePatternsEqual(toTextPattern(/a/i), toTextPattern(/a/g))).toBe(false);
    expect(routePatternsEqual(toTextPattern('a'), toTextPattern(/a/))).toBe(false);
  });
});

describe('assertRoutePatternCanMatchUrl', () => {
  it.each([
    '/api/orders',
    '/api/*',
    'api/orders',
    'orders',
    'api/orders:batch',
    '../api/orders',
    '//host.test/api/orders',
    '\\/api/orders',
    'api*',
    '*',
    '*/orders',
    'api?*',
  ])('rejects path-only pattern %s', (value) => {
    expect(() => assertRoutePatternCanMatchUrl(toTextPattern(value))).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining(JSON.stringify(value)),
      }),
    );
  });

  it.each([
    ['*://*/api/orders', 'https://x.test/api/orders'],
    ['http???x.test/api/orders', 'http://x.test/api/orders'],
    ['http*//x.test/api/orders', 'http://x.test/api/orders'],
    ['http\\://x.test/a\\*b', 'http://x.test/a*b'],
  ])('accepts full-URL pattern %s', (value, url) => {
    const pattern = toTextPattern(value);
    expect(() => assertRoutePatternCanMatchUrl(pattern)).not.toThrow();
    expect(routePatternMatches(pattern, url)).toBe(true);
  });

  it('accepts a path-shaped RegExp', () => {
    expect(() => assertRoutePatternCanMatchUrl(toTextPattern(/^\/api\/orders$/))).not.toThrow();
  });
});
