/**
 * `browser.cookies(urls)` against a real browser context: only the cookies a
 * request to the URL would carry come back, by domain, path, and `Secure`,
 * and no URL still returns every cookie. Firefox and WebKit run where
 * Playwright's builds are installed.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firefox, webkit } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser } from '../../src/browser.ts';
import type { BrowserName } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const BASE = 'http://app.example/';

const browsers: readonly { name: BrowserName; installed: boolean }[] = [
  { name: 'chromium', installed: true },
  { name: 'firefox', installed: existsSync(firefox.executablePath()) },
  { name: 'webkit', installed: existsSync(webkit.executablePath()) },
];

describe.each(browsers)('browser.cookies(urls) in $name', ({ name, installed }) => {
  const surface = new PlaywrightSurface({ browser: name });
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-cookies-url-'));
  const signal = new AbortController().signal;
  let browser: Browser;

  beforeAll(async () => {
    if (!installed) return;
    await surface.init({ runId: 'cookies', targetName: 'web', projectRoot, app: { site: 'app.example' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.startAttempt({ attemptId: 'cookies', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await surface.ensurePage();
    browser = createBrowserFixture(surface, {
      app: { site: 'app.example', resolveUrl: (url: string) => new URL(url, BASE).href },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'cookies', attemptId: 'cookies', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
    await browser.setCookies([
      { name: 'host', value: '1', domain: 'app.example', path: '/' },
      { name: 'site', value: '1', domain: '.app.example', path: '/' },
      { name: 'admin', value: '1', domain: 'app.example', path: '/admin' },
      { name: 'secure', value: '1', domain: 'app.example', path: '/', secure: true },
      { name: 'api', value: '1', domain: 'api.app.example', path: '/' },
      { name: 'other', value: '1', domain: 'other.example', path: '/' },
      { name: 'local', value: '1', domain: 'localhost', path: '/', secure: true },
    ]);
  });

  afterAll(async () => {
    if (installed) {
      await surface.endAttempt({ signal, timeoutMs: 5_000 });
      await surface.dispose({ signal, timeoutMs: 5_000 });
    }
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it.skipIf(!installed).each<[string, string | readonly string[] | undefined, string[]]>([
    ['every cookie without a URL', undefined, ['admin', 'api', 'host', 'local', 'other', 'secure', 'site']],
    ['a relative URL resolves against the base URL', '/', ['host', 'site']],
    ['a path cookie under its path', '/admin/users?page=2', ['admin', 'host', 'site']],
    ['no path cookie for a path that only shares its prefix', '/administrator', ['host', 'site']],
    ['a Secure cookie over https', 'https://app.example/', ['host', 'secure', 'site']],
    ['a Secure cookie over http on localhost', 'http://localhost:3000/', ['local']],
    ['a subdomain gets the domain cookie, not the host-only one', 'http://api.app.example/', ['api', 'site']],
    ['another domain gets only its own', 'http://other.example/', ['other']],
    ['a parent domain gets none of its subdomain\'s', 'http://example/', []],
    ['several URLs union', ['http://other.example/', '/admin'], ['admin', 'host', 'other', 'site']],
    ['an empty list matches nothing', [], []],
  ])('%s', async (_title, urls, expected) => {
    expect((await browser.cookies(urls)).map((cookie) => cookie.name).toSorted()).toEqual(expected);
  });

  it.skipIf(!installed)('refuses a value that is not a URL and a URL that holds no cookies', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_ARGUMENT' });
    expect(() => browser.cookies(1 as unknown as string)).toThrow(invalid);
    expect(() => browser.cookies(['/', null] as unknown as string[])).toThrow(invalid);
    expect(() => browser.cookies('about:blank')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });
});
