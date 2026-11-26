/**
 * `browser.clock` in a real browser: Playwright's page clock on the attempt's
 * context, through navigation, `app.restart()`, `app.clearState()`, and tabs
 * the app opens, and the engine's own page-side waits under a paused clock.
 * Driven through the engine hooks and the `browser` fixture, as the attempt
 * executor drives them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, surfaceOf, type Browser, type BrowserClock } from '../../src/index.ts';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const T0 = Date.parse('2024-02-02T08:00:00Z');
const HOUR = 3_600_000;

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'run-clock', attemptId: 'c1', origin: 'test' };
}

describe('browser.clock', () => {
  let app: FixtureApp;
  let artifactsDir: string;

  beforeAll(async () => {
    app = await startFixtureApp();
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-clock-'));
  });

  afterAll(async () => {
    await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Runs `body` in one attempt of a fresh engine, with no page open yet. */
  async function inAttempt(body: (engine: EngineHandle, clock: BrowserClock, browser: Browser) => Promise<void>, timeoutMs?: number): Promise<void> {
    const engine = web({});
    await engine.init!({
      runId: 'run-clock', targetName: 'web', projectRoot: process.cwd(),
      app: { site: new URL(app.url).hostname }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'c1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    const browser = engine.fixtures!['browser']!({
      operation: () => operation(timeoutMs),
      app: { resolveUrl: (url: string) => new URL(url, app.url).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
    try {
      await body(engine, browser.clock, browser);
    } finally {
      await engine.endAttempt!(cleanup());
      await engine.dispose!(cleanup());
    }
  }

  async function open(engine: EngineHandle): Promise<void> {
    await engine.session!.open!(`${app.url}/clock`, operation());
  }

  /** What the clock page shows: the instant it loaded, the page's time now, and whether its one-second timer fired. */
  function read(engine: EngineHandle): Promise<{ loaded: string; now: number; timer: string }> {
    return surfaceOf(engine)!.page().evaluate(() => ({
      loaded: document.getElementById('loaded')!.textContent!,
      now: Date.now(),
      timer: document.getElementById('timer')!.textContent!,
    }));
  }

  const iso = (ms: number) => new Date(ms).toISOString();

  it('pauses at a time, and fires a timer only as runFor reaches it, through a navigation', async () => {
    await inAttempt(async (engine, clock) => {
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await open(engine);
      expect(await read(engine)).toEqual({ loaded: iso(T0 + HOUR), now: T0 + HOUR, timer: 'waiting' });
      await clock.runFor(999);
      expect(await read(engine)).toMatchObject({ now: T0 + HOUR + 999, timer: 'waiting' });
      await clock.runFor('00:01');
      expect(await read(engine)).toMatchObject({ now: T0 + HOUR + 1999, timer: 'fired' });
      await open(engine);
      expect(await read(engine)).toEqual({ loaded: iso(T0 + HOUR + 1999), now: T0 + HOUR + 1999, timer: 'waiting' });
    });
  });

  it('moves the wall time without firing a timer on setSystemTime, and fires it once on fastForward', async () => {
    await inAttempt(async (engine, clock) => {
      await clock.install({ time: new Date(T0) });
      await clock.pauseAt(iso(T0 + HOUR));
      await open(engine);
      await clock.setSystemTime(T0 + 2 * HOUR);
      expect(await read(engine)).toMatchObject({ now: T0 + 2 * HOUR, timer: 'waiting' });
      await clock.fastForward(5000);
      expect(await read(engine)).toMatchObject({ now: T0 + 2 * HOUR + 5000, timer: 'fired' });
    });
  });

  it('holds Date at a fixed time while timers keep running, and lets a paused clock resume', async () => {
    await inAttempt(async (engine, clock) => {
      await clock.setFixedTime(T0);
      await open(engine);
      const page = surfaceOf(engine)!.page();
      await page.waitForFunction(() => document.getElementById('timer')!.textContent === 'fired');
      expect(await read(engine)).toEqual({ loaded: iso(T0), now: T0, timer: 'fired' });

      await clock.pauseAt(T0 + HOUR);
      await open(engine);
      await clock.resume();
      await page.waitForFunction(() => document.getElementById('timer')!.textContent === 'fired');
      expect((await read(engine)).now).toBeGreaterThan(T0 + HOUR);
    });
  });

  it('keeps the clock through app.restart(), app.clearState(), and in a tab the app opens', async () => {
    await inAttempt(async (engine, clock) => {
      // No time: the clock starts at the runner's now, which the replay keeps.
      const paused = Date.now() + 24 * HOUR;
      await clock.install();
      await clock.pauseAt(paused);
      await clock.runFor(500);
      const expected = { loaded: iso(paused + 500), now: paused + 500, timer: 'waiting' };
      await open(engine);
      expect(await read(engine)).toEqual(expected);
      await engine.session!.restart!(operation());
      await open(engine);
      expect(await read(engine)).toEqual(expected);
      await engine.session!.reset!(operation());
      await open(engine);
      expect(await read(engine)).toEqual(expected);

      const live = surfaceOf(engine)!;
      const [popup] = await Promise.all([
        live.context().waitForEvent('page'),
        live.page().evaluate(() => { window.open('/clock'); }),
      ]);
      await popup.waitForLoadState('load');
      expect(await popup.evaluate(() => Date.now())).toBe(paused + 500);
    });
  });

  it('reaches a page already open and its frames, and keeps its place among init scripts through app.clearState()', async () => {
    await inAttempt(async (engine, clock, browser) => {
      // Before the clock: this script reads the native Date. After it: the clock's.
      await browser.addInitScript(() => { Reflect.set(window, 'before', Date.now()); });
      await open(engine);
      const page = surfaceOf(engine)!.page();
      await page.evaluate(() => {
        const frame = document.createElement('iframe');
        frame.srcdoc = '<p>framed</p>';
        document.body.append(frame);
        return new Promise((resolve) => { frame.addEventListener('load', resolve, { once: true }); });
      });
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await browser.addInitScript(() => { Reflect.set(window, 'after', Date.now()); });
      expect((await read(engine)).now).toBe(T0 + HOUR);
      expect(await page.frames()[1]!.evaluate(() => Date.now())).toBe(T0 + HOUR);

      // A reset closes the page, so each read takes the current one.
      const scripts = () => surfaceOf(engine)!.page().evaluate(() => ({ before: Reflect.get(window, 'before') as number, after: Reflect.get(window, 'after') as number }));
      for (const replace of [false, true]) {
        if (replace) await engine.session!.reset!(operation());
        await open(engine);
        const { before, after } = await scripts();
        expect(Math.abs(before - Date.now())).toBeLessThan(HOUR);
        expect(after).toBe(T0 + HOUR);
      }
    });
  });

  it('scrolls, observes, and reads the viewport while the page clock is paused', async () => {
    // A wait on the page's own timers would hold a step until this budget ends.
    await inAttempt(async (engine, clock) => {
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await open(engine);
      const op = operation(5_000);
      const snapshot = await engine.observe!(op);
      await engine.perform!(snapshot.root.ref, { kind: 'swipe', direction: 'down' }, op);
      expect(await surfaceOf(engine)!.page().evaluate(() => window.scrollY)).toBeGreaterThan(0);
      const [footer] = await engine.locate!({ kind: 'selector', selector: '#footer' }, op);
      // The engine's own reads queue nothing in the page's clock: a pending timer would change its requestIdleCallback.
      const timers = () => surfaceOf(engine)!.page().evaluate(() => (Reflect.get(window, '__pwClock') as { controller: { countTimers(): number } }).controller.countTimers());
      const before = await timers();
      expect(await engine.viewportIntersection!(footer!.ref, op)).toEqual({ intersects: false, ratio: 0 });
      expect(await timers()).toBe(before);
      expect(await read(engine)).toMatchObject({ now: T0 + HOUR, timer: 'waiting' });
    }, 5_000);
  });

  it('refuses an argument Playwright would misread or reject, changing nothing', async () => {
    await inAttempt(async (engine, clock) => {
      const refused = (message: string) => expect.objectContaining({ code: 'INVALID_ARGUMENT', message });
      await expect(clock.install('2024-02-02' as unknown as { time: number })).rejects.toThrow(refused('browser.clock.install options must be a plain object'));
      await expect(clock.install({ time: T0, at: 1 } as unknown as { time: number })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(clock.pauseAt('')).rejects.toThrow(refused('browser.clock.pauseAt takes epoch milliseconds, a date string, or a valid Date, got ""'));
      await expect(clock.setFixedTime(new Date(Number.NaN))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(clock.setSystemTime('soon')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(clock.runFor(-1)).rejects.toThrow(refused("browser.clock.runFor takes milliseconds of zero or more, or 'ss', 'mm:ss', or 'hh:mm:ss', got -1"));
      await expect(clock.fastForward('01:60')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(clock.runFor('1:2:3:4')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await open(engine);
      expect((await read(engine)).timer).toBe('waiting');
      expect(Math.abs((await read(engine)).now - Date.now())).toBeLessThan(HOUR);

      // Back in time is the test's argument too, though only the page knows its clock.
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await expect(clock.pauseAt(T0)).rejects.toThrow(refused("browser.clock.pauseAt: the time is before the clock's current time"));
    });
  });

  it('keeps a failed or refused call\'s effect the same in the page, the next document, and after app.clearState()', async () => {
    await inAttempt(async (engine, clock) => {
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await open(engine);
      await surfaceOf(engine)!.page().evaluate(() => { setTimeout(() => { throw new Error('boom'); }, 10); });
      // Playwright logs a call for the next document before it runs it, so a failed one counts there too.
      await expect(clock.runFor(100)).rejects.toMatchObject({ code: 'EVALUATE_FAILED' });
      // A refused one must not reach that log.
      await expect(clock.pauseAt(T0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect((await read(engine)).now).toBe(T0 + HOUR + 100);
      await open(engine);
      expect((await read(engine)).now).toBe(T0 + HOUR + 100);
      await engine.session!.reset!(operation());
      await open(engine);
      expect((await read(engine)).now).toBe(T0 + HOUR + 100);
    });
  });

  it('fails a call whose page timer throws as the page\'s, and bounds a timer loop that never ends', async () => {
    await inAttempt(async (engine, clock) => {
      await clock.install({ time: T0 });
      await clock.pauseAt(T0 + HOUR);
      await open(engine);
      const page = surfaceOf(engine)!.page();
      await page.evaluate(() => { setTimeout(() => { throw new Error('boom'); }, 10); });
      await expect(clock.runFor(100)).rejects.toThrow(expect.objectContaining({ code: 'EVALUATE_FAILED', message: 'browser.clock.runFor: a page timer threw: Error: boom' }));

      await page.evaluate(() => { setInterval(() => undefined, 1); });
      await expect(clock.runFor(10 * HOUR)).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    }, 2_000);
  });
});
