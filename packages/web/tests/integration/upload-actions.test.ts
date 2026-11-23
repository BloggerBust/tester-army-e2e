/**
 * `setInputFiles` against a real page, through both kinds of target the
 * engine acts on: a file input and a label for one take the files without a
 * click, a button that opens a hidden input's chooser is clicked and the
 * chooser takes them, an empty list clears either, and a button that opens
 * nothing or a path that does not exist fails.
 */

import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifyActionError, dispatchLocatorAction } from '../../src/actions.ts';
import type { ActionTarget } from '../../src/support.ts';

let browser: Browser;
let page: Page;
let file: string;

beforeAll(async () => {
  browser = await chromium.launch();
  file = path.join(mkdtempSync(path.join(tmpdir(), 'e2e-upload-')), 'avatar.png');
  writeFileSync(file, 'png');
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

/** Uploads `paths`, the fixture file by default, and returns the contract error it failed with, classified as the engine reports it. */
async function upload(target: ActionTarget, paths: readonly string[] = [file]): Promise<Error | undefined> {
  const action = { kind: 'setInputFiles', paths } as const;
  try {
    await dispatchLocatorAction(target, action, { timeoutMs: 2000, signal: new AbortController().signal }, () => {
      throw new Error('no second target');
    });
    return undefined;
  } catch (cause) {
    return classifyActionError(cause, action);
  }
}

/** The page's record of the file the input holds and the clicks it saw. */
function state(): Promise<{ files: string; clicks: number }> {
  return page.evaluate(() => ({
    files: Array.from(document.querySelector<HTMLInputElement>('#avatar')!.files ?? [], (picked) => picked.name).join(', '),
    clicks: (window as unknown as { clicks: number }).clicks,
  }));
}

const COUNT_CLICKS = '<script>window.clicks = 0; document.addEventListener("click", () => window.clicks++, true)</script>';

/** Node's own message for a path that cannot be stat'ed, which the engine reports as is. */
function statFailure(target: string): string {
  try {
    statSync(target);
  } catch (cause) {
    return (cause as Error).message;
  }
  throw new Error(`${target} exists`);
}

describe.each(KINDS)('through the %s target', (kind) => {
  it('sets a file input directly', async () => {
    await page.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#avatar'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('sets the input a label names without clicking the label', async () => {
    await page.setContent(`<label id="pick" for="avatar">Choose avatar</label><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect(await state()).toEqual({ files: 'avatar.png', clicks: 0 });
  });

  it('clicks a button over a hidden input and sets the files through its chooser', async () => {
    await page.setContent(`
      <button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button>
      <input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, '#pick'))).toBeUndefined();
    expect((await state()).files).toBe('avatar.png');
  });

  it.each([
    ['a file input', '<input id="avatar" type="file">', '#avatar'],
    ['a button over a hidden input', `<button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button><input id="avatar" type="file" hidden>`, '#pick'],
  ])('clears %s with an empty list and fires input and change', async (_name, html, selector) => {
    await page.setContent(`${html}${COUNT_CLICKS}`);
    expect(await upload(await targetOf(kind, selector))).toBeUndefined();
    await page.evaluate(() => {
      const events: string[] = [];
      (window as unknown as { events: string[] }).events = events;
      const input = document.querySelector('#avatar')!;
      input.addEventListener('input', () => events.push('input'));
      input.addEventListener('change', () => events.push('change'));
    });
    expect(await upload(await targetOf(kind, selector), [])).toBeUndefined();
    expect((await state()).files).toBe('');
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['input', 'change']);
  });

  it.each([
    ['input', '<input id="avatar" type="file" multiple>', '#avatar'],
    ['label', '<label id="pick" for="avatar">Choose</label><input id="avatar" type="file" multiple hidden>', '#pick'],
    ['chooser', `<button id="pick" onclick="document.getElementById('avatar').click()">Choose</button><input id="avatar" type="file" multiple hidden>`, '#pick'],
  ])('preserves in-memory file metadata and binary contents through a %s', async (_name, html, selector) => {
    await page.setContent(html);
    const files = [
      { name: 'résumé.bin', mimeType: 'application/octet-stream', buffer: new Uint8Array([17, 0, 128, 255, 18]).subarray(1, 4) },
      { name: 'empty.txt', mimeType: 'text/plain', buffer: new Uint8Array() },
    ];
    await dispatchLocatorAction(await targetOf(kind, selector), { kind: 'setInputFilePayloads', files },
      { timeoutMs: 2000, signal: new AbortController().signal }, () => { throw new Error('no second target'); });
    expect(await page.locator('#avatar').evaluate(async (node: HTMLInputElement) => Promise.all(
      Array.from(node.files ?? [], async (picked) => ({
        name: picked.name, mimeType: picked.type, bytes: Array.from(new Uint8Array(await picked.arrayBuffer())),
      })),
    ))).toEqual([
      { name: 'résumé.bin', mimeType: 'application/octet-stream', bytes: [0, 128, 255] },
      { name: 'empty.txt', mimeType: 'text/plain', bytes: [] },
    ]);
    expect(await upload(await targetOf(kind, selector), [])).toBeUndefined();
    expect(await page.locator('#avatar').evaluate((node: HTMLInputElement) => node.files?.length)).toBe(0);
  });

  it.each([
    ['a file input', '<input id="avatar" type="file">', '#avatar'],
    ['a button over a hidden input', `<button id="pick" type="button" onclick="document.getElementById('avatar').click()">Choose avatar</button><input id="avatar" type="file" hidden>`, '#pick'],
  ])('fails a path that does not exist as INVALID_ARGUMENT before it touches %s', async (_name, html, selector) => {
    await page.setContent(`${html}${COUNT_CLICKS}`);
    for (const missing of [path.join(path.dirname(file), 'missing.png'), path.join(file, 'inside-a-file.png')]) {
      const error = await upload(await targetOf(kind, selector), [file, missing]);
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', category: 'test', message: `setInputFiles path does not exist or is under a directory the runner cannot search: ${statFailure(missing)}` });
      expect((error as Error).message).toContain(missing);
    }
    expect(await state()).toEqual({ files: '', clicks: 0 });
  });

  // Permission bits do not stop a Windows or root process, so only a non-root POSIX runner sees `EACCES`.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails a path under a directory it may not search as INVALID_ARGUMENT',
    async () => {
      await page.setContent(`<input id="avatar" type="file">${COUNT_CLICKS}`);
      const locked = path.join(path.dirname(file), `locked-${kind}`);
      mkdirSync(locked);
      const hidden = path.join(locked, 'avatar.png');
      writeFileSync(hidden, 'png');
      chmodSync(locked, 0o000);
      try {
        const error = await upload(await targetOf(kind, '#avatar'), [hidden]);
        expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', category: 'test', message: `setInputFiles path does not exist or is under a directory the runner cannot search: EACCES: permission denied, stat '${hidden}'` });
      } finally {
        chmodSync(locked, 0o700);
      }
      expect(await state()).toEqual({ files: '', clicks: 0 });
    },
  );

  it('fails when the button opens no file chooser', async () => {
    await page.setContent(`<button id="pick" type="button">Choose avatar</button><input id="avatar" type="file" hidden>${COUNT_CLICKS}`);
    const error = await upload(await targetOf(kind, '#pick'));
    expect(error).toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining('opened no file chooser') });
    expect((await state()).files).toBe('');
  });
});
