/**
 * `browser.setCookies` against a real browser context: every shape the
 * `Cookie` type allows lands as written, and anything else is
 * `INVALID_ARGUMENT` naming the field, before the browser is asked, so a
 * test's cookie mistake is not reported as an engine failure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser, type Cookie } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** Answers every path with an empty page. */
function startServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Cookies</title>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('browser.setCookies', () => {
  const surface = new PlaywrightSurface({});
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-set-cookies-'));
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    const started = await startServer();
    server = started.server;
    origin = `http://127.0.0.1:${started.port}`;
    await surface.init({ runId: 'cookies', targetName: 'web', projectRoot, app: { site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'cookies', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    const page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    browser = createBrowserFixture(surface, {
      app: { site: '127.0.0.1', resolveUrl: (url: string) => new URL(url, `${origin}/`).href },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'cookies', attemptId: 'cookies', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('sets every shape the Cookie type allows as written', async () => {
    const tomorrow = Math.floor(Date.now() / 1000) + 86_400;
    await browser.setCookies([
      { name: 'session', value: 'root', domain: '127.0.0.1' },
      { name: 'admin', value: '', domain: '127.0.0.1', path: '/admin', httpOnly: true, secure: false, sameSite: 'Strict' },
      { name: 'theme', value: 'dark', url: `${origin}/settings`, expires: tomorrow, sameSite: 'Lax' },
      { name: 'lang', value: 'en', url: '/' },
    ]);
    const cookies = (await browser.cookies()).map(({ name, value, path: at, httpOnly, sameSite, expires }) => ({ name, value, at, httpOnly, sameSite, expires }));
    expect(cookies.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'admin', value: '', at: '/admin', httpOnly: true, sameSite: 'Strict', expires: undefined },
      { name: 'lang', value: 'en', at: '/', httpOnly: false, sameSite: 'Lax', expires: undefined },
      { name: 'session', value: 'root', at: '/', httpOnly: false, sameSite: 'Lax', expires: undefined },
      { name: 'theme', value: 'dark', at: '/', httpOnly: false, sameSite: 'Lax', expires: tomorrow },
    ]);
  });

  it('takes a domain with a leading dot', async () => {
    await browser.setCookies([{ name: 'session', value: 'root', domain: '.127.0.0.1' }]);
    expect((await browser.cookies()).map(({ name, domain }) => ({ name, domain }))).toEqual([{ name: 'session', domain: '127.0.0.1' }]);
  });

  it.each([
    ['an uppercase host', 'EXAMPLE.test', 'example.test'],
    ['a punycode host', 'xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a unicode host', 'bücher.example', 'xn--bcher-kva.example'],
    ['an IPv6 host', '[::1]', '[::1]'],
    ['a host with a trailing dot', 'example.test.', 'example.test.'],
  ])('takes %s as the host it names', async (_name, domain, stored) => {
    await browser.setCookies([{ name: 'session', value: 'root', domain }]);
    expect((await browser.cookies()).map((cookie) => cookie.domain)).toEqual([stored]);
  });

  it('takes -1 as a session cookie and the end of the year 9999 as the latest expiry', async () => {
    await browser.setCookies([
      { name: 'session', value: 'root', domain: '127.0.0.1', expires: -1 },
      { name: 'theme', value: 'dark', domain: '127.0.0.1', expires: 253_402_300_799 },
    ]);
    const cookies = (await browser.cookies()).map(({ name, expires }) => ({ name, persistent: expires !== undefined }));
    expect(cookies.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'session', persistent: false },
      { name: 'theme', persistent: true },
    ]);
  });

  it('takes back the cookies browser.cookies returns', async () => {
    await browser.setCookies([
      { name: 'session', value: 'root', domain: '127.0.0.1', httpOnly: true, sameSite: 'Strict' },
      { name: 'theme', value: 'dark', url: '/settings', expires: Math.floor(Date.now() / 1000) + 86_400 },
    ]);
    const saved = await browser.cookies();
    await browser.clearCookies();
    await browser.setCookies(saved);
    expect(await browser.cookies()).toEqual(saved);
  });

  const base = { name: 'session', value: 'root', domain: '127.0.0.1' };

  it.each<[string, unknown, string]>([
    ['a single cookie, not an array', base, 'browser.setCookies takes an array of cookies, got an object'],
    ['a null entry', [null], 'browser.setCookies cookies[0] must be an object, got null'],
    ['an array entry', [['session', 'root']], 'cookies[0] must be an object, got an array'],
    ['no url and no domain', [{ name: 'session', value: 'root' }], 'cookies[0] needs a url, or a domain with an optional path'],
    ['url and domain', [{ ...base, url: '/' }], 'cookies[0] takes url, or domain with an optional path, not both'],
    ['url and path', [{ name: 'session', value: 'root', url: '/', path: '/admin' }], 'cookies[0] takes url, or domain with an optional path, not both'],
    ['an empty domain', [{ ...base, domain: '' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got ""'],
    ['a domain with a scheme', [{ ...base, domain: 'https://127.0.0.1' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "https://127.0.0.1"'],
    ['a domain with a path', [{ ...base, domain: '127.0.0.1/app' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "127.0.0.1/app"'],
    ['a domain with a port', [{ ...base, domain: '127.0.0.1:4399' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "127.0.0.1:4399"'],
    ['a domain with a space', [{ ...base, domain: ' 127.0.0.1' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got " 127.0.0.1"'],
    ['a short IPv4 domain the parser fills in', [{ ...base, domain: '1.2.3' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "1.2.3"'],
    ['a percent-encoded domain', [{ ...base, domain: '%41.com' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "%41.com"'],
    ['a domain with an empty label', [{ ...base, domain: 'a..example.com' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "a..example.com"'],
    ['a domain with two leading dots', [{ ...base, domain: '..example.com' }], 'cookies[0] domain must be a host name like "example.com" or ".example.com", got "..example.com"'],
    ['a missing name', [{ value: 'root', domain: '127.0.0.1' }], 'cookies[0] name must be a string, got undefined'],
    ['a number value', [{ ...base, value: 5 }], 'cookies[0] value must be a string, got 5'],
    ['a string expires', [{ ...base, expires: '1999999999' }], 'cookies[0] expires must be a Unix timestamp in seconds (not milliseconds), got "1999999999"'],
    ['a NaN expires', [{ ...base, expires: Number.NaN }], 'cookies[0] expires must be a Unix timestamp in seconds (not milliseconds), got NaN'],
    ['an expires in milliseconds', [{ ...base, expires: 1_767_225_600_000 }], 'cookies[0] expires must be a Unix timestamp in seconds (not milliseconds), got 1767225600000'],
    ['a negative expires', [{ ...base, expires: -5 }], 'cookies[0] expires must be a Unix timestamp in seconds (not milliseconds), got -5'],
    ['an expires past the year 9999', [{ ...base, expires: 253_402_300_800 }], 'cookies[0] expires must be a Unix timestamp in seconds (not milliseconds), got 253402300800'],
    ['a string httpOnly', [{ ...base, httpOnly: 'true' }], 'cookies[0] httpOnly must be a boolean, got "true"'],
    ['a lowercase sameSite', [{ ...base, sameSite: 'strict' }], 'cookies[0] sameSite must be "Strict", "Lax", or "None", got "strict"'],
    ['an unknown key', [{ ...base, maxAge: 60 }], 'cookies[0] has unknown key "maxAge"; expected one of name, value, url, domain, path, expires, httpOnly, secure, sameSite'],
    ['a misspelled key', [{ ...base, samesite: 'Lax' }], 'cookies[0] has unknown key "samesite"; did you mean "sameSite"?'],
    ['a hole', Object.assign([base], { 2: base }), 'browser.setCookies cookies[1] must be an object, got undefined'],
    ['a bad second cookie', [base, { ...base, sameSite: 'lax' }], 'browser.setCookies cookies[1] sameSite'],
  ])('refuses %s with INVALID_ARGUMENT, setting nothing', async (_name, cookies, message) => {
    expect(() => browser.setCookies(cookies as readonly Cookie[])).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: expect.stringContaining(message) }),
    );
    expect(await browser.cookies()).toEqual([]);
  });
});
