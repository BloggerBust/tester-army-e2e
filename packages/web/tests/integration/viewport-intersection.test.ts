/**
 * `viewportIntersection` measures what Playwright's `toBeInViewport` does:
 * the share of an element's box inside the viewport once the viewport and
 * every clipping ancestor, a scroll container or a frame included, cut it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocatorExpression, NodeRef } from '@e2e-dev/core/engine';
import { surfaceOf, web } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const BOX = 'position: absolute; width: 100px; height: 100px';

const DOCUMENT = `
  <style>body { margin: 0; height: 3000px }</style>
  <div id="inside" style="${BOX}; left: 10px; top: 10px"></div>
  <div id="half-off" style="${BOX}; left: -50px; top: 200px"></div>
  <div id="below" style="${BOX}; left: 10px; top: 2000px"></div>
  <div style="${BOX}; left: 300px; top: 10px; overflow: hidden">
    <div id="half-clipped" style="${BOX}; left: 50px"></div>
    <div id="clipped-out" style="${BOX}; top: 200px"></div>
  </div>
  <div style="${BOX}; left: 500px; top: 10px; overflow: auto">
    <div style="height: 1000px"></div>
    <div id="scrolled-away" style="height: 50px"></div>
  </div>
  <div id="empty" style="position: absolute; left: 10px; top: 400px; width: 0; height: 10px"></div>
  <div id="flat" style="position: absolute; left: 10px; top: 420px; width: 10px; height: 0"></div>
  <div id="no-box" style="display: none"></div>
  <input id="secret" type="password" value="hunter2" style="position: absolute; left: 10px; top: 500px">
  <iframe id="frame" style="${BOX}; left: 700px; top: 10px; border: 0"
    srcdoc="<div id='framed' style='${BOX}; left: 50px; top: 0'></div>"></iframe>
`;

describe('viewport intersection on the web engine', () => {
  const engine = web({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-viewport-'));
  const signal = new AbortController().signal;
  const operation = { signal, timeoutMs: 5_000, runId: 'viewport', attemptId: 'attempt', origin: 'test' as const };
  const cleanup = { signal, timeoutMs: 30_000 };
  let page: Page;

  /** The one element `selector` names, inside `frame` when given. */
  async function locate(selector: string, frame?: string): Promise<NodeRef> {
    const source: LocatorExpression = { kind: 'selector', selector };
    const [node, ...rest] = await engine.locate!(frame === undefined ? source : { kind: 'frame', selector: frame, source }, operation);
    expect(rest).toEqual([]);
    return node!.ref;
  }

  const measure = async (selector: string, frame?: string) =>
    engine.viewportIntersection!(await locate(selector, frame), operation);

  beforeAll(async () => {
    await engine.init!({ runId: 'viewport', targetName: 'fixture', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
    await engine.startAttempt!({ attemptId: 'attempt', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    await engine.session!.open!('about:blank', operation);
    page = surfaceOf(engine)!.page();
    await page.setContent(DOCUMENT);
    await page.frameLocator('#frame').locator('#framed').waitFor({ state: 'attached' });
  });

  afterAll(async () => {
    await engine.endAttempt!(cleanup);
    await engine.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('measures the share of the box the viewport and clipping ancestors leave', async () => {
    expect(await measure('#inside')).toEqual({ intersects: true, ratio: 1 });
    expect(await measure('#half-off')).toEqual({ intersects: true, ratio: 0.5 });
    expect(await measure('#below')).toEqual({ intersects: false, ratio: 0 });
    expect(await measure('#half-clipped')).toEqual({ intersects: true, ratio: 0.5 });
    expect(await measure('#clipped-out')).toEqual({ intersects: false, ratio: 0 });
    expect(await measure('#scrolled-away')).toEqual({ intersects: false, ratio: 0 });
    expect(await measure('#framed', '#frame')).toEqual({ intersects: true, ratio: 0.5 });
  });

  it('reads an element with no box or an empty one as outside', async () => {
    expect(await measure('#empty')).toEqual({ intersects: false, ratio: 0 });
    expect(await measure('#flat')).toEqual({ intersects: false, ratio: 0 });
    expect(await measure('#no-box')).toEqual({ intersects: false, ratio: 0 });
  });

  it('measures a password field like any other element', async () => {
    expect(await measure('#secret')).toEqual({ intersects: true, ratio: 1 });
  });

  it('follows scrolling, and a removed element is stale', async () => {
    const below = await locate('#below');
    await page.evaluate(() => window.scrollTo(0, 1950));
    expect(await engine.viewportIntersection!(below, operation)).toEqual({ intersects: true, ratio: 1 });
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.locator('#below').evaluate((element) => element.remove());
    await expect(engine.viewportIntersection!(below, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('reads an element the page replaces every frame as stale, never as outside', async () => {
    await page.evaluate(() => {
      const make = () => {
        const ticker = document.createElement('button');
        ticker.id = 'ticker';
        ticker.textContent = 'Ticker';
        ticker.style.cssText = 'position: fixed; left: 10px; top: 600px';
        return ticker;
      };
      document.body.append(make());
      const swap = () => {
        document.getElementById('ticker')?.replaceWith(make());
        requestAnimationFrame(swap);
      };
      requestAnimationFrame(swap);
    });
    for (let round = 0; round < 5; round += 1) {
      const ticker = await locate('#ticker');
      await expect(engine.viewportIntersection!(ticker, operation)).rejects.toMatchObject({ code: 'NODE_STALE' });
    }
  });
});
