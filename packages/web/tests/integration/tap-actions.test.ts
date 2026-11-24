/**
 * `multiTap` against a real page, through both kinds of target the engine
 * acts on: `count` clicks arrive as one sequence with a rising `detail`, as a
 * person's triple click does, so a triple click selects a paragraph, and the
 * held keys ride every click of it.
 */

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LocatorAction } from '@e2e-dev/core/engine';
import { dispatchLocatorAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

beforeEach(async () => {
  await page?.close();
  page = await browser.newPage();
});

const KINDS = ['locator', 'element'] as const;

/** The control as the engine would hold it: a locator, or an element handle pinned by an observation. */
async function targetOf(kind: (typeof KINDS)[number], selector: string): Promise<ActionTarget> {
  const locator = page.locator(selector);
  if (kind === 'locator') return { kind, locator };
  const element = await locator.elementHandle();
  if (element === null) throw new Error(`no element for ${selector}`);
  return { kind, element };
}

function dispatch(target: ActionTarget, action: LocatorAction): Promise<void> {
  return dispatchLocatorAction(target, action, { timeoutMs: 2000, signal: new AbortController().signal }, () => {
    throw new Error('no second target');
  });
}

/** Logs every click's `detail` and Shift state, and every `dblclick`, on `window.events`. */
const LOG_CLICKS = `<script>
  window.events = [];
  document.addEventListener('click', (event) => window.events.push('click:' + event.detail + (event.shiftKey ? '+shift' : '')), true);
  document.addEventListener('dblclick', () => window.events.push('dblclick'), true);
</script>`;

function events(): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { events: string[] }).events);
}

describe.each(KINDS)('through the %s target', (kind) => {
  it('clicks count times as one sequence, as a triple click does', async () => {
    await page.setContent(`<button id="go">Go</button>${LOG_CLICKS}`);
    await dispatch(await targetOf(kind, '#go'), { kind: 'multiTap', count: 3 });
    expect(await events()).toEqual(['click:1', 'click:2', 'dblclick', 'click:3']);
  });

  it('selects a whole paragraph with a triple click', async () => {
    await page.setContent('<p id="para">Three little words and more</p><p>Next paragraph</p>');
    await dispatch(await targetOf(kind, '#para'), { kind: 'multiTap', count: 3 });
    expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim()).toBe('Three little words and more');
  });

  it('holds the modifiers for every click', async () => {
    await page.setContent(`<button id="go">Go</button>${LOG_CLICKS}`);
    await dispatch(await targetOf(kind, '#go'), { kind: 'multiTap', count: 4, modifiers: ['Shift'] });
    expect(await events()).toEqual(['click:1+shift', 'click:2+shift', 'dblclick', 'click:3+shift', 'click:4+shift']);
  });
});
