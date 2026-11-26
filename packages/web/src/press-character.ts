/**
 * `press` with a character that has no key on the US keyboard layout
 * Playwright presses from (`é`, `€`, `中`). Chromium takes a key event for any
 * character over CDP, so the page gets the same `keydown`, `input`, and
 * `keyup` as for a US key, with an empty `code` and a `keyCode` of 0: no
 * physical key stands behind it.
 */

import type { Page } from 'playwright-core';
import { EngineError, parseKey, type KeyModifier } from '@e2e-dev/core/engine';
import type { BrowserName } from './browser-connection.ts';
import type { ConnectionBudget } from './operation-budget.ts';
import type { ActionTarget } from './support.ts';

const US_LAYOUT_CHARACTER = /^[ -~]$/;

/** The `modifiers` bits of CDP's `Input.dispatchKeyEvent`. */
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;

export interface CharacterPress {
  readonly character: string;
  readonly modifiers: readonly KeyModifier[];
}

/**
 * A `press` key the engine sends itself, because Playwright has no key for
 * its character; `undefined` for a key Playwright presses. Throws
 * `UNSUPPORTED_CAPABILITY` outside Chromium, where no channel takes the key.
 */
export function requireCharacterPress(key: string, browser: BrowserName): CharacterPress | undefined {
  const parsed = parseKey(key);
  if (parsed?.key.kind !== 'char' || US_LAYOUT_CHARACTER.test(parsed.key.char)) return undefined;
  if (browser !== 'chromium') {
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      `press cannot send "${parsed.key.char}" on ${browser}: only Chromium presses a character that is not on a US keyboard. Enter it with fill or pressSequentially.`,
      { retryable: false },
    );
  }
  return { character: parsed.key.char, modifiers: parsed.modifiers };
}

/** Focuses the node, as Playwright's `press` does, and presses the character on it; `checkpoint` is `pressCharacter`'s. */
export async function pressCharacterOn(target: ActionTarget, page: Page, press: CharacterPress, operation: ConnectionBudget, checkpoint: () => void): Promise<void> {
  // An ElementHandle call takes no timeout: the element is already resolved.
  if (target.kind === 'locator') await target.locator.focus({ timeout: operation.timeoutMs });
  else await target.element.focus();
  await pressCharacter(page, press, checkpoint);
}

/**
 * Presses the character on whatever holds focus. Opening the CDP session can
 * outlast the operation or the connection, so `checkpoint`
 * (`AttemptSession.checkpoint`) runs between it and the first key.
 */
export async function pressCharacter(page: Page, press: CharacterPress, checkpoint: () => void): Promise<void> {
  const { character } = press;
  const cdp = await page.context().newCDPSession(page);
  const held: KeyModifier[] = [];
  try {
    checkpoint();
    try {
      // Playwright holds the modifiers, so its own record of what is down stays true.
      for (const modifier of press.modifiers) {
        await page.keyboard.down(modifier);
        held.push(modifier);
      }
      const modifiers = press.modifiers.reduce((bits, modifier) => bits | MODIFIER_BITS[resolveModifier(modifier)], 0);
      // As for a US key, a modifier other than Shift makes the key a shortcut that types nothing.
      const text = press.modifiers.every((modifier) => modifier === 'Shift') ? { text: character, unmodifiedText: character } : {};
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: character, modifiers, ...text });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character, modifiers });
    } catch (cause) {
      // The key's own failure is the one to report.
      await release(page, held).catch(() => undefined);
      throw cause;
    }
    await release(page, held);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Releases every held modifier, last first, then throws the first failure: a modifier that may still be down is not a finished press. */
async function release(page: Page, held: readonly KeyModifier[]): Promise<void> {
  const failures: unknown[] = [];
  for (const modifier of held.toReversed()) await page.keyboard.up(modifier).catch((cause: unknown) => { failures.push(cause); });
  if (failures.length > 0) throw failures[0];
}

/** `ControlOrMeta` as Playwright resolves it: by the platform of the process driving the browser. */
function resolveModifier(modifier: KeyModifier): keyof typeof MODIFIER_BITS {
  if (modifier !== 'ControlOrMeta') return modifier;
  return process.platform === 'darwin' ? 'Meta' : 'Control';
}
