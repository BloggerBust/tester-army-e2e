import { toTextPattern } from '@e2e-dev/core/engine';
import { describe, expect, it } from 'vitest';
import {
  parseRoutePattern,
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

describe('parseRoutePattern', () => {
  it.each([
    '',
    '/api/orders',
    '/api/*',
    'api/orders',
    'orders',
    'api/orders:batch',
    '../api/orders',
    '//host.test/api/orders',
    '\\/api/orders',
    'localhost:3000/api/orders',
    'x.test:3000/**',
    'x.test:*/api/**',
    '127.0.0.1:8080',
    'LOCALHOST:3000/api/orders',
    'http\\\\*://x.test/',
    '*',
    '*/api/orders',
    '*.x.test/api',
    'api*',
    'orders*',
    'web:3000/api/orders',
    'tel:123',
  ])('rejects invalid route pattern %s', (value) => {
    expect(() => parseRoutePattern('route', value)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining(`browser.route pattern ${JSON.stringify(value)}`),
      }),
    );
  });

  it('names the method and suggests the supplied path on any origin', () => {
    expect(() => parseRoutePattern('unroute', '/api/quote')).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/^browser\.unroute pattern .* "\*\*\/api\/quote" .*regular expression$/) }),
    );
    expect(() => parseRoutePattern('waitForResponse', 'localhost:3000/api/quote')).toThrowError(
      expect.objectContaining({ message: expect.stringMatching(/^browser\.waitForResponse pattern .*full URL.*regular expression$/) }),
    );
  });

  it.each([
    ['**', 'https://x.test/api/orders'],
    ['*://*/api/orders', 'https://x.test/api/orders'],
    ['*\\://*/api/orders', 'https://x.test/api/orders'],
    ['http???x.test/api/orders', 'http://x.test/api/orders'],
    ['???????x.test/api/orders', 'http://x.test/api/orders'],
    ['http*//x.test/api/orders', 'http://x.test/api/orders'],
    ['http://localhost:3000/**', 'http://localhost:3000/api/orders'],
    ['http://x.test:*/api/**', 'http://x.test:3000/api/orders'],
    ['http\\://x.test/a\\*b', 'http://x.test/a*b'],
  ])('accepts pattern %s and matches %s', (value, url) => {
    expect(routePatternMatches(parseRoutePattern('route', value), url)).toBe(true);
  });

  it('accepts a path-shaped RegExp', () => {
    expect(parseRoutePattern('route', /^\/api\/orders$/)).toEqual(toTextPattern(/^\/api\/orders$/));
  });
});
