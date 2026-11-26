/** Which `press` keys the engine sends itself, on which browser, and the order of its input around the checkpoint. */

import type { Locator as PwLocator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { pressCharacter, pressCharacterOn, requireCharacterPress } from '../../src/press-character.ts';

describe('requireCharacterPress', () => {
  it.each([' ', '~', 'a', '$', '+', 'Enter', 'Control+a', 'Shift++', 'Shift+Tab'])('leaves %j to Playwright on every browser', (key) => {
    for (const browser of ['chromium', 'firefox', 'webkit'] as const) expect(requireCharacterPress(key, browser)).toBeUndefined();
  });

  it.each(['é', 'ß', '€', '中', '😀', ' ', '¡'])('presses %j itself on Chromium', (key) => {
    expect(requireCharacterPress(key, 'chromium')).toEqual({ character: key, modifiers: [] });
  });

  it('keeps the modifiers in the order written', () => {
    expect(requireCharacterPress('ControlOrMeta+Alt+中', 'chromium')).toEqual({ character: '中', modifiers: ['ControlOrMeta', 'Alt'] });
  });

  it.each([['é', 'firefox'], ['Control+é', 'firefox'], ['中', 'webkit']] as const)('refuses %j on %s', (key, browser) => {
    expect(() => requireCharacterPress(key, browser)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }));
  });
});

describe('the input of a character press', () => {
  const stale = new Error('stale');
  const fakePage = (failing?: string) => {
    const calls: string[] = [];
    const step = async (call: string) => {
      calls.push(call);
      if (call === failing) throw new Error(`${call} failed`);
    };
    const cdp = {
      send: (_method: string, params: { type: string; key: string; modifiers: number; text?: string }) => step(`${params.type} ${params.key} ${params.modifiers}${params.text === undefined ? '' : ' text'}`),
      detach: () => step('detach'),
    };
    const page = {
      context: () => ({ newCDPSession: async () => { calls.push('attach'); return cdp; } }),
      keyboard: { down: (key: string) => step(`down ${key}`), up: (key: string) => step(`up ${key}`) },
    } as unknown as Page;
    return { calls, page, checkpoint: () => { calls.push('checkpoint'); } };
  };
  const control = process.platform === 'darwin' ? 4 : 2;

  it('checks after the session opens and before the first key', async () => {
    const { calls, page, checkpoint } = fakePage();
    await pressCharacter(page, { character: 'é', modifiers: [] }, checkpoint);
    expect(calls).toEqual(['attach', 'checkpoint', 'keyDown é 0 text', 'keyUp é 0', 'detach']);
  });

  it('holds the modifiers around the key, which then types nothing', async () => {
    const { calls, page, checkpoint } = fakePage();
    await pressCharacter(page, { character: 'é', modifiers: ['ControlOrMeta', 'Shift'] }, checkpoint);
    expect(calls).toEqual([
      'attach', 'checkpoint', 'down ControlOrMeta', 'down Shift',
      `keyDown é ${control | 8}`, `keyUp é ${control | 8}`,
      'up Shift', 'up ControlOrMeta', 'detach',
    ]);
  });

  it('releases the modifiers it held when the key fails', async () => {
    const { calls, page, checkpoint } = fakePage('keyDown é 3');
    await expect(pressCharacter(page, { character: 'é', modifiers: ['Control', 'Alt'] }, checkpoint)).rejects.toThrow('keyDown é 3 failed');
    expect(calls.slice(-3)).toEqual(['up Alt', 'up Control', 'detach']);
  });

  it('fails when a modifier cannot be released, after releasing the rest', async () => {
    const { calls, page, checkpoint } = fakePage('up Alt');
    await expect(pressCharacter(page, { character: 'é', modifiers: ['Control', 'Alt'] }, checkpoint)).rejects.toThrow('up Alt failed');
    expect(calls.slice(-3)).toEqual(['up Alt', 'up Control', 'detach']);
  });

  it.each([
    ['the focused element', (page: Page, checkpoint: () => void) => pressCharacter(page, { character: 'é', modifiers: ['Control'] }, checkpoint)],
    ['a node', (page: Page, checkpoint: () => void) => pressCharacterOn({ kind: 'locator', locator: { focus: async () => undefined } as unknown as PwLocator }, page, { character: 'é', modifiers: ['Control'] }, { timeoutMs: 7, signal: new AbortController().signal }, checkpoint)],
  ])('sends nothing to %s when the checkpoint throws', async (_target, press) => {
    const { calls, page } = fakePage();
    await expect(press(page, () => { throw stale; })).rejects.toBe(stale);
    expect(calls).toEqual(['attach', 'detach']);
  });
});
