/** `press` with a character off the US keyboard layout, through the engine in a real browser. */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EngineHandle, LocatorExpression, OperationContext } from '@e2e-dev/core/engine';
import { web, type WebOptions } from '../../src/index.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

const KEY_LOG = `<script>
  const row = (event) => [event.type, event.key ?? event.data, ...(event.ctrlKey ? ['ctrl'] : []), ...(event.shiftKey ? ['shift'] : [])].join(':');
  for (const type of ['keydown', 'input', 'keyup']) {
    document.addEventListener(type, (event) => { document.querySelector('[data-testid=keys]').value += row(event) + ';'; }, true);
  }
</script>`;
const FRAME = `<input data-testid='inner'><script>addEventListener('keydown', (event) => { document.title += event.key; })</script>`;
const PAGE = `<!doctype html><meta charset="utf-8">
<input data-testid="open">
<label>Name <input></label>
<textarea data-testid="keys" readonly></textarea>
<div data-testid="rich" contenteditable="true"></div>
<input data-testid="count" type="number">
<button data-testid="go">Go</button>
<iframe srcdoc="${FRAME}"></iframe>
${KEY_LOG}`;

const by = (kind: 'testId' | 'label', value: string): LocatorExpression => ({ kind: 'query', query: { kind, value: { kind: 'string', value, exact: true } } });
const OPEN = by('testId', 'open');
/** A label query pins an element handle, where a test id keeps a locator: the two targets `press` acts on. */
const LABELLED = by('label', 'Name');
const GO = by('testId', 'go');
const KEYS = by('testId', 'keys');
const INNER: LocatorExpression = { kind: 'frame', selector: 'iframe', source: by('testId', 'inner') };

interface Harness {
  readonly engine: EngineHandle;
  readonly press: (expression: LocatorExpression, key: string) => Promise<void>;
  readonly pressFocused: (key: string) => Promise<void>;
  readonly valueOf: (expression: LocatorExpression) => Promise<string | undefined>;
  readonly close: () => Promise<void>;
}

async function start(options: WebOptions): Promise<Harness> {
  const engine = web(options);
  const signal = new AbortController().signal;
  const op: OperationContext = { signal, timeoutMs: 30_000, runId: 'press', attemptId: 'press-1', origin: 'test' };
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-press-'));
  await engine.init!({ runId: 'press', targetName: 'web', projectRoot: process.cwd(), app: {}, env: {}, headed: false, workerSlot: 0, log: () => undefined, signal });
  await engine.startAttempt!({ attemptId: 'press-1', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
  const one = async (expression: LocatorExpression) => {
    const [node] = await engine.locate!(expression, op);
    if (node === undefined) throw new Error(`no node for ${JSON.stringify(expression)}`);
    return node;
  };
  return {
    engine,
    press: async (expression, key) => engine.perform!((await one(expression)).ref, { kind: 'press', key }, op),
    pressFocused: async (key) => {
      await engine.observe!(op);
      await engine.keyboard!.press(key, op);
    },
    valueOf: async (expression) => (await one(expression)).value,
    close: async () => {
      await engine.endAttempt!({ signal, timeoutMs: 30_000 });
      await engine.dispose!({ signal, timeoutMs: 30_000 });
      rmSync(artifactsDir, { recursive: true, force: true });
    },
  };
}

const open = (harness: Harness) => harness.engine.session!.open!(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`, { signal: new AbortController().signal, timeoutMs: 30_000, runId: 'press', attemptId: 'press-1', origin: 'test' });

describe('press with a character off the US keyboard layout, in Chromium', () => {
  let chromium: Harness;
  beforeAll(async () => { chromium = await start({}); });
  beforeEach(() => open(chromium));
  afterAll(() => chromium.close());

  it.each([['a locator', OPEN], ['an element handle', LABELLED]])('types each character into the field %s addresses', async (_target, field) => {
    for (const key of ['e', 'é', 'ß', '€', '中', '😀']) await chromium.press(field, key);
    expect(await chromium.valueOf(field)).toBe('eéß€中😀');
  });

  it('sends the key events of a US key', async () => {
    await chromium.press(OPEN, 'e');
    await chromium.press(OPEN, 'é');
    expect(await chromium.valueOf(KEYS)).toBe('keydown:e;input:e;keyup:e;keydown:é;input:é;keyup:é;');
  });

  it('types into a contenteditable node', async () => {
    const rich = by('testId', 'rich');
    await chromium.press(rich, 'é');
    await chromium.pressFocused('中');
    expect(await chromium.valueOf(KEYS)).toBe('keydown:é;input:é;keyup:é;keydown:中;input:中;keyup:中;');
  });

  it('types into the focused field', async () => {
    await chromium.press(OPEN, 'a');
    await chromium.pressFocused('é');
    expect(await chromium.valueOf(OPEN)).toBe('aé');
  });

  it('types into a field of an iframe, by node and by focus', async () => {
    await chromium.press(INNER, 'é');
    await chromium.pressFocused('ß');
    expect(await chromium.valueOf(INNER)).toBe('éß');
  });

  it('presses the key on a button, which types nothing', async () => {
    await chromium.press(GO, 'é');
    expect(await chromium.valueOf(KEYS)).toBe('keydown:é;keyup:é;');
  });

  it('leaves a number input to refuse the character itself', async () => {
    const count = by('testId', 'count');
    await chromium.press(count, '5');
    await chromium.press(count, 'é');
    expect(await chromium.valueOf(count)).toBe('5');
  });

  it.each([['a node', (key: string) => chromium.press(OPEN, key)], ['the focused field', (key: string) => chromium.pressFocused(key)]])('holds a modifier over the key on %s and releases it', async (_target, press) => {
    await chromium.press(OPEN, 'a');
    await press('Control+é');
    await press('b');
    expect(await chromium.valueOf(OPEN)).toBe('ab');
    expect(await chromium.valueOf(KEYS)).toContain('keydown:Control:ctrl;keydown:é:ctrl;keyup:é:ctrl;keyup:Control;keydown:b;');
  });

  it('types the character with Shift held', async () => {
    await chromium.press(OPEN, 'Shift+é');
    expect(await chromium.valueOf(OPEN)).toBe('é');
    expect(await chromium.valueOf(KEYS)).toContain('keydown:é:shift;');
  });
});

describe.skipIf(!existsSync(firefox.executablePath()))('press with a character off the US keyboard layout, in Firefox', () => {
  let other: Harness;
  beforeAll(async () => { other = await start({ browser: 'firefox' }); }, 60_000);
  beforeEach(() => open(other));
  afterAll(() => other.close());

  it('refuses the character before any input and still presses a US key', async () => {
    await expect(other.press(OPEN, 'é')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(other.press(OPEN, 'Control+é')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    await expect(other.pressFocused('é')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(await other.valueOf(KEYS)).toBe('');
    await other.press(OPEN, 'a');
    expect(await other.valueOf(OPEN)).toBe('a');
    expect(await other.valueOf(KEYS)).toBe('keydown:a;input:a;keyup:a;');
  });
});
