/**
 * `browser.name` and `browser.version` against real browsers: the name is
 * the engine the target drives, and the version is the one the running
 * browser reports, checked against what its own page says, for a launched
 * browser and for one attached over CDP. Firefox and WebKit run where
 * Playwright's builds are installed.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firefox, webkit } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, type Browser, type BrowserName, type WebOptions } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(): OperationContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'run-info', attemptId: 'info', origin: 'test' };
}

/** What the page itself knows of its browser's version: the full one on Chromium, the user agent's elsewhere. */
function pageVersion(browser: Browser): Promise<string> {
  return browser.evaluate(async () => {
    const data = (navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ fullVersionList: { brand: string; version: string }[] }> };
    }).userAgentData;
    if (data === undefined) return navigator.userAgent;
    const { fullVersionList } = await data.getHighEntropyValues(['fullVersionList']);
    return fullVersionList.map((entry) => `${entry.brand}/${entry.version}`).join(' ');
  });
}

let app: FixtureApp;
let artifactsDir: string;

beforeAll(async () => {
  app = await startFixtureApp();
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-browser-info-'));
});

afterAll(async () => {
  await app.close();
  rmSync(artifactsDir, { recursive: true, force: true });
});

/** The `browser` fixture of the engine's attempt; `signal` is the one that attempt's harness gives it. */
function fixtureOf(engine: EngineHandle, signal: AbortSignal): Browser {
  return engine.fixtures!['browser']!({
    operation,
    signal,
    timeouts: { test: 30_000 },
    app: { resolveUrl: (url: string) => new URL(url, app.url).href },
    expectable: (target: object) => target,
    fixture: (_name: string, target: object) => target,
    attachArtifact: () => undefined,
  } as unknown as EngineFixtureContext) as Browser;
}

/** Runs `body` in one attempt of an engine built from `options`, with the app open, then disposes the engine. */
async function withBrowser(options: WebOptions, body: (browser: Browser, engine: EngineHandle) => Promise<void>): Promise<void> {
  const engine = web(options);
  await engine.init!({
    runId: 'run-info', targetName: 'web', projectRoot: process.cwd(),
    app: { site: new URL(app.url).hostname }, env: {}, headed: false,
    workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
  });
  try {
    await engine.startAttempt!({ attemptId: 'info', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const browser = fixtureOf(engine, new AbortController().signal);
    await body(browser, engine);
  } finally {
    await engine.dispose!(cleanup());
  }
}

const browsers: readonly { name: BrowserName; installed: boolean; inPage: (version: string) => string }[] = [
  { name: 'chromium', installed: true, inPage: (version) => `/${version}` },
  { name: 'firefox', installed: existsSync(firefox.executablePath()), inPage: (version) => `Firefox/${version.split('.')[0]}.` },
  { name: 'webkit', installed: existsSync(webkit.executablePath()), inPage: (version) => `Version/${version}` },
];

describe.each(browsers)('browser identity in $name', ({ name, installed, inPage }) => {
  it.skipIf(!installed)('names the engine and reports the version the page itself reports', async () => {
    await withBrowser({ browser: name }, async (browser) => {
      // Before any page opens: a test skips on the browser first.
      expect(browser.name).toBe(name);
      expect(browser.version).toMatch(/^\d+(\.\d+)+$/);
      await browser.goto('/');
      expect(await pageVersion(browser)).toContain(inPage(browser.version));
    });
  }, 60_000);

  it.skipIf(!installed)('keeps the real version when the target overrides the user agent', async () => {
    let real = '';
    await withBrowser({ browser: name }, async (browser) => { real = browser.version; });
    await withBrowser({ browser: name, userAgent: 'Custom/1.0' }, async (browser) => {
      await browser.goto('/');
      expect(await browser.evaluate(() => navigator.userAgent)).toBe('Custom/1.0');
      expect(browser.version).toBe(real);
      expect(browser.name).toBe(name);
    });
  }, 60_000);
});

describe('browser identity over CDP', () => {
  let chrome: RemoteChrome;

  beforeAll(async () => {
    chrome = await launchRemoteChrome();
  }, 60_000);

  afterAll(async () => {
    if (chrome !== undefined) await closeRemoteChrome(chrome);
  });

  it('reports the attached browser by what its own DevTools endpoint reports', async () => {
    const { port } = new URL(chrome.endpoint);
    const reported = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as { Browser: string };
    await withBrowser({ connect: { cdpEndpoint: () => chrome.endpoint } }, async (browser) => {
      expect(browser.name).toBe('chromium');
      expect(reported.Browser.split('/')[1]).toBe(browser.version);
    });
  }, 60_000);
});

describe('browser identity outside an attempt', () => {
  it('is INVALID_STATE once the attempt ended, not a stale answer', async () => {
    await withBrowser({}, async (browser, engine) => {
      expect(browser.version).not.toBe('');
      await engine.endAttempt!(cleanup());
      expect(() => browser.name).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(() => browser.version).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    });
  }, 60_000);

  it('stays INVALID_STATE on a fixture kept into the next attempt, whose browser is not its own', async () => {
    await withBrowser({}, async (browser, engine) => {
      await engine.endAttempt!(cleanup());
      await engine.startAttempt!({ attemptId: 'next', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      expect(() => browser.name).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(() => browser.version).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    });
  }, 60_000);

  it('is INVALID_STATE on a fixture first made after its attempt ended, while the next one runs', async () => {
    await withBrowser({}, async (_browser, engine) => {
      const ended = new AbortController();
      await engine.endAttempt!(cleanup());
      ended.abort();
      await engine.startAttempt!({ attemptId: 'next', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
      const late = fixtureOf(engine, ended.signal);
      expect(() => late.name).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
      expect(() => late.version).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
    });
  }, 60_000);
});
