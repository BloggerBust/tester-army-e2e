/**
 * `browser.setNetwork` in a real browser: offline fails the page's requests
 * and navigations the way a lost connection does, reaches the page's service
 * worker, so a cached document still loads, and holds for the rest of the
 * attempt, through `app.restart()` and `app.clearState()`, until the test
 * goes back online. The next attempt starts online. Driven through the engine
 * hooks and the `browser` fixture, as the attempt executor drives them.
 * Firefox and WebKit run where Playwright's builds are installed.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firefox, webkit } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, surfaceOf, type Browser, type BrowserName } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

const browsers: readonly { name: BrowserName; installed: boolean }[] = [
  { name: 'chromium', installed: true },
  { name: 'firefox', installed: existsSync(firefox.executablePath()) },
  { name: 'webkit', installed: existsSync(webkit.executablePath()) },
];

describe.each(browsers)('browser.setNetwork in $name', ({ name, installed }) => {
  let app: FixtureApp;
  let artifactsDir: string;
  let engine: EngineHandle;
  let attempts = 0;

  function operation(): OperationContext {
    return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-network', attemptId: `n${attempts}`, origin: 'test' };
  }

  beforeAll(async () => {
    if (!installed) return;
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-network-'));
    engine = web({ browser: name });
    await engine.init!({
      runId: 'run-network', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
  });

  afterAll(async () => {
    if (!installed) return;
    await engine.dispose!(cleanup());
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Runs `body` in an attempt of its own on the worker's one browser, as the runner runs each test. */
  async function attempt(body: (browser: Browser) => Promise<void>): Promise<void> {
    attempts += 1;
    await engine.startAttempt!({ attemptId: `n${attempts}`, artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    try {
      await body(engine.fixtures!['browser']!({
        operation,
        timeouts: { test: 30_000 },
        app: { resolveUrl: (url: string) => new URL(url, app.url).href },
        expectable: (target: object) => target,
        fixture: (_name: string, target: object) => target,
        attachArtifact: () => undefined,
      } as unknown as EngineFixtureContext) as Browser);
    } finally {
      await engine.endAttempt!(cleanup());
    }
  }

  /**
   * What the open page sees of the network: `navigator.onLine`, and whether a
   * request to the app is answered. The request skips the HTTP cache, which
   * answers offline in some browsers.
   */
  function reading(): Promise<{ onLine: boolean; answered: boolean }> {
    return surfaceOf(engine)!.page().evaluate(async () => ({
      onLine: navigator.onLine,
      answered: await fetch('/form', { cache: 'no-store' }).then((response) => response.ok, () => false),
    }));
  }

  const ONLINE = { onLine: true, answered: true };
  const OFFLINE = { onLine: false, answered: false };

  it.skipIf(!installed)('fails requests and navigations offline, on the open page at once, and restores them online', async () => {
    await attempt(async (browser) => {
      await browser.goto('/');
      expect(await reading()).toEqual(ONLINE);
      const page = surfaceOf(engine)!.page();
      await page.evaluate(() => {
        const heard: string[] = [];
        Object.assign(window, { heard });
        for (const type of ['offline', 'online']) addEventListener(type, () => { heard.push(type); });
      });
      await browser.setNetwork('offline');
      expect(await reading()).toEqual(OFFLINE);
      expect(await page.evaluate(() => (window as unknown as { heard: string[] }).heard)).toEqual(['offline']);
      // Whether a route still fulfills a request offline is the browser's own: Firefox fails it.
      await browser.route('**/mocked', (route) => route.fulfill({ body: 'mocked' }));
      const mocked = await page.evaluate(() => fetch('/mocked').then((response) => response.text(), () => 'failed'));
      expect(mocked).toBe(name === 'firefox' ? 'failed' : 'mocked');
      await expect(browser.goto('/form')).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringContaining("navigation failed: the browser is offline (browser.setNetwork('offline'))"),
      });
      await browser.setNetwork('online');
      await browser.goto('/form');
      expect(await browser.title()).toBe('Fixture Form');
      expect(await reading()).toEqual(ONLINE);
    });
  });

  it.skipIf(!installed)('leaves the HTTP cache to the browser: Chromium answers from a fresh entry, Firefox from any, WebKit from none', async () => {
    await attempt(async (browser) => {
      await browser.goto('/');
      const page = surfaceOf(engine)!.page();
      const answered = (url: string) => page.evaluate((target) => fetch(target).then((response) => response.ok, () => false), url);
      expect(await answered('/fresh')).toBe(true);
      await browser.setNetwork('offline');
      expect({ fresh: await answered('/fresh'), stored: await answered('/') }).toEqual({
        fresh: name !== 'webkit',
        stored: name === 'firefox',
      });
    });
  });

  it.skipIf(!installed)('leaves a connection that is already open alone: an event stream keeps delivering', async () => {
    await attempt(async (browser) => {
      await browser.goto('/');
      const page = surfaceOf(engine)!.page();
      await page.evaluate(() => new Promise<void>((resolve) => {
        const ticks = { count: 0 };
        Object.assign(window, { ticks });
        new EventSource('/events').addEventListener('message', () => { ticks.count += 1; resolve(); });
      }));
      await browser.setNetwork('offline');
      const before = await page.evaluate(() => (window as unknown as { ticks: { count: number } }).ticks.count);
      await page.waitForFunction((seen) => (window as unknown as { ticks: { count: number } }).ticks.count > seen + 2, before);
      expect(await reading()).toEqual(OFFLINE);
    });
  });

  it.skipIf(!installed)('loads a document its service worker cached, where the worker\'s own request fails too', async () => {
    await attempt(async (browser) => {
      await browser.goto('/pwa');
      await surfaceOf(engine)!.page().evaluate(() => (window as unknown as { controlled: Promise<boolean> }).controlled);
      await browser.setNetwork('offline');
      await browser.reload();
      expect(await browser.title()).toBe('Fixture PWA');
      expect(await reading()).toEqual(OFFLINE);
    });
  });

  it.skipIf(!installed)('holds through a restart, a context reset, and on a tab opened after, for the rest of the attempt', async () => {
    await attempt(async (browser) => {
      // Before the first page: the page that opens next is offline from its first request.
      await browser.setNetwork('offline');
      await expect(browser.goto('/')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await engine.session!.restart!(operation());
      await expect(browser.goto('/')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await engine.session!.reset!(operation());
      await expect(browser.goto('/')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await browser.newTab();
      await expect(browser.goto('/')).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await browser.setNetwork('online');
      await browser.goto('/');
      expect(await reading()).toEqual(ONLINE);
      await browser.setNetwork('offline');
    });
    // The attempt above ended offline; the next one starts online.
    await attempt(async (browser) => {
      await browser.goto('/');
      expect(await reading()).toEqual(ONLINE);
    });
  });

  it.skipIf(!installed)('refuses a state other than online and offline, changing nothing', async () => {
    await attempt(async (browser) => {
      await browser.goto('/');
      for (const state of ['slow-3g', true, undefined]) {
        await expect(browser.setNetwork(state as 'offline')).rejects.toThrow(expect.objectContaining({
          code: 'INVALID_ARGUMENT',
          message: `browser.setNetwork takes "online" or "offline", got ${JSON.stringify(state)}`,
        }));
      }
      expect(await reading()).toEqual(ONLINE);
    });
  });
});
