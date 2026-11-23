/** The contract's `press` grammar spelled as an agent-desktop key combo. */

import { EngineError, parseKey, type KeyModifier, type KeyName } from '@e2e-dev/core/engine';

/**
 * agent-desktop's name for each contract key. Its `delete` is the key that
 * deletes backwards, as a Mac labels it, so the forward Delete is
 * `forwarddelete`. Insert has no key on a Mac keyboard and no name there.
 */
const KEY_NAMES: Readonly<Record<KeyName, string | undefined>> = {
  Enter: 'return',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'forwarddelete',
  Insert: undefined,
  Space: 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  F1: 'f1',
  F2: 'f2',
  F3: 'f3',
  F4: 'f4',
  F5: 'f5',
  F6: 'f6',
  F7: 'f7',
  F8: 'f8',
  F9: 'f9',
  F10: 'f10',
  F11: 'f11',
  F12: 'f12',
};

/**
 * The characters agent-desktop's macOS key map presses besides letters and
 * digits. Any other one (`!`, `é`) has no key of its own there, and is
 * refused before a locator's press focuses its control. `+` is not one: the
 * combo syntax uses it as the separator.
 */
const PUNCTUATION = new Set([',', '.', '/', ';', "'", '[', ']', '\\', '-', '=', '`']);

function modifierName(modifier: KeyModifier): string {
  switch (modifier) {
    case 'Shift':
      return 'shift';
    case 'Control':
      return 'ctrl';
    case 'Alt':
      return 'alt';
    case 'Meta':
    case 'ControlOrMeta':
      return 'cmd';
  }
}

/**
 * The shortcuts agent-desktop refuses to press unless forced, which the
 * engine never is: on macOS they quit, log out, force-quit, or lock the
 * session. It refuses any combo with one's key and at least its modifiers,
 * so `cmd+q` stands for `cmd+shift+q` and `ctrl+cmd+q` too.
 */
const REFUSED_SHORTCUTS: readonly { readonly key: string; readonly modifiers: readonly string[] }[] = [
  { key: 'q', modifiers: ['cmd'] },
  { key: 'escape', modifiers: ['cmd', 'alt'] },
  { key: 'backspace', modifiers: ['cmd', 'shift'] },
];

/**
 * The combo agent-desktop's `press` takes for one contract key: `Enter` is
 * `return`, `ControlOrMeta+a` is `cmd+a`.
 * A key agent-desktop has no name for is `UNSUPPORTED_CAPABILITY`, and so is
 * `+`, which its combo syntax uses as the separator, and a shortcut it
 * refuses (`REFUSED_SHORTCUTS`).
 */
export function toCombo(key: string): string {
  const parsed = parseKey(key);
  if (parsed === undefined) throw new EngineError('UNSUPPORTED_CAPABILITY', `"${key}" is not a key in the press grammar`, { retryable: false });
  let name: string | undefined;
  if (parsed.key.kind === 'named') {
    name = KEY_NAMES[parsed.key.name];
  } else if (parsed.key.char === ' ') {
    name = 'space';
  } else if (/^[A-Za-z0-9]$/.test(parsed.key.char) || PUNCTUATION.has(parsed.key.char)) {
    // agent-desktop lower-cases a combo and adds Shift for a lone capital letter, so a capital needs no help.
    name = parsed.key.char;
  }
  if (name === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `agent-desktop cannot press "${key}" on macOS`, { retryable: false });
  }
  const modifiers = parsed.modifiers.map(modifierName);
  // A capital letter with other modifiers loses its case in agent-desktop's combo, so Shift says it.
  if (parsed.key.kind === 'char' && /^[A-Z]$/.test(parsed.key.char) && modifiers.length > 0 && !modifiers.includes('shift')) modifiers.push('shift');
  const pressed = name.toLowerCase();
  if (REFUSED_SHORTCUTS.some((shortcut) => shortcut.key === pressed && shortcut.modifiers.every((modifier) => modifiers.includes(modifier)))) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `agent-desktop refuses to press "${key}", a shortcut that quits, logs out, force-quits, or locks the session; end the app with desktop.closeApp()`, { retryable: false });
  }
  return [...modifiers, name].join('+');
}
