/**
 * Every locator action refuses an option key it does not take. A JavaScript
 * test ported from Playwright can pass `{ trial: true }` or `{ force: true }`;
 * ignoring the key would commit the action the test meant to only rehearse,
 * so the call fails before a node is resolved or a step recorded. The same
 * file covers each action's own argument checks.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  resolveExpression,
  type KeyModifier,
  type LocatorAction,
  type LocatorActionKind,
  type LocatorExpression,
  LOCATOR_ACTION_KINDS,
} from '@e2e-dev/core/lib/engine/index';
import type { ActionOptions, Locator, Screen, TapOptions } from '@e2e-dev/core/lib/types';
import { invalid } from '../helpers/invalid.ts';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

const BOX = { ref: { id: 'agree', revision: '' }, role: 'checkbox' as const, name: 'Agree' };
const BIN = { ref: { id: 'bin', revision: '' }, role: 'region' as const, name: 'Bin' };
const NODES = [BOX, BIN];

type Call = (locator: Locator, options: ActionOptions, screen: Screen) => Promise<void>;

const CALLS: Record<string, Call> = {
  tap: (locator, options) => locator.tap(options),
  click: (locator, options) => locator.click(options),
  doubleTap: (locator, options) => locator.doubleTap(options),
  dblclick: (locator, options) => locator.dblclick(options),
  secondaryTap: (locator, options) => locator.secondaryTap(options),
  longPress: (locator, options) => locator.longPress(options),
  fill: (locator, options) => locator.fill('yes', options),
  clear: (locator, options) => locator.clear(options),
  press: (locator, options) => locator.press('Enter', options),
  check: (locator, options) => locator.check(options),
  uncheck: (locator, options) => locator.uncheck(options),
  selectOption: (locator, options) => locator.selectOption('Team', options),
  focus: (locator, options) => locator.focus(options),
  hover: (locator, options) => locator.hover(options),
  setInputFiles: (locator, options) => locator.setInputFiles('fixtures/a.txt', options),
  dragTo: (locator, options, screen) => locator.dragTo(screen.getByRole('region', { name: 'Bin' }), options),
  scrollIntoView: (locator, options) => locator.scrollIntoView(options),
  swipe: (locator, options) => locator.swipe({ direction: 'down', ...options }),
};

/** A screen over a checkbox and a drop region, logging every node lookup and every action the engine receives. */
function boxScreen() {
  const performed: string[] = [];
  const actions: LocatorAction[] = [];
  const locate = vi.fn(async (expression: LocatorExpression) => resolveExpression(expression, NODES));
  const { screen, steps } = screenOver({
    locate,
    observe: () => snapshot(NODES),
    perform: (_ref, action) => {
      performed.push(action.kind);
      actions.push(action);
    },
    timeoutMs: 1_000,
  });
  return { screen, steps, performed, actions, locate };
}

describe('locator action options', () => {
  it.each(Object.entries(CALLS))('%s rejects an unknown option before any lookup, action, or step', async (verb, call) => {
    const { screen, steps, performed, locate } = boxScreen();
    await expect(
      Promise.resolve().then(() => call(screen.getByLabel('Agree'), invalid<ActionOptions>({ trial: true }), screen)),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(`^${verb} options has no key "trial"`) });
    expect(locate).not.toHaveBeenCalled();
    expect(performed).toEqual([]);
    expect(steps.all()).toEqual([]);
  });

  it.each(Object.entries(CALLS))('%s performs with a timeout', async (verb, call) => {
    const { screen, steps, performed } = boxScreen();
    await call(screen.getByLabel('Agree'), { timeout: 1_000 }, screen);
    expect(performed).toHaveLength(1);
    expect(steps.all()).toEqual([expect.objectContaining({ api: `locator.${verb}`, status: 'passed' })]);
  });

  describe('modifiers', () => {
    /** A screen over the box whose engine declares `tapModifiers` or not, keeping every action it receives. */
    function modifierScreen(tapModifiers: boolean | undefined) {
      const received: LocatorAction[] = [];
      const { screen, steps } = screenOver({
        locate: (expression) => resolveExpression(expression, NODES),
        observe: () => snapshot(NODES),
        perform: (_ref, action) => {
          received.push(action);
        },
        ...(tapModifiers === undefined ? {} : { tapModifiers }),
        timeoutMs: 1_000,
      });
      return { screen, steps, received };
    }

    it.each([
      ['tap', (locator: Locator) => locator.tap({ modifiers: ['Shift'] })],
      ['click', (locator: Locator) => locator.click({ modifiers: ['Shift'] })],
      ['doubleTap', (locator: Locator) => locator.doubleTap({ modifiers: ['Shift'] })],
      ['dblclick', (locator: Locator) => locator.dblclick({ modifiers: ['Shift'] })],
      ['secondaryTap', (locator: Locator) => locator.secondaryTap({ modifiers: ['Shift'] })],
    ] as const)('%s hands the held keys to an engine that declares tapModifiers', async (verb, call) => {
      const { screen, steps, received } = modifierScreen(true);
      await call(screen.getByLabel('Agree'));
      expect(received).toEqual([{ kind: verb === 'click' ? 'tap' : verb === 'dblclick' ? 'doubleTap' : verb, modifiers: ['Shift'] }]);
      expect(steps.all()).toEqual([
        expect.objectContaining({ api: `locator.${verb}`, label: 'getByLabel("Agree") with Shift', status: 'passed' }),
      ]);
    });

    it('leaves the field off an action that names no modifier, an empty list included', async () => {
      const { screen, received } = modifierScreen(undefined);
      await screen.getByLabel('Agree').tap({ modifiers: [] });
      await screen.getByLabel('Agree').doubleTap();
      expect(received).toEqual([{ kind: 'tap' }, { kind: 'doubleTap' }]);
    });

    it('refuses modifiers on an engine that does not declare tapModifiers, before it acts', async () => {
      const { screen, received } = modifierScreen(undefined);
      await expect(screen.getByLabel('Agree').tap({ modifiers: ['Shift'] })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('modifiers on the "tap" action'),
      });
      expect(received).toEqual([]);
    });

    it('refuses modifiers on such an engine before resolving, so a missing node is not LOCATOR_NOT_FOUND', async () => {
      const { screen } = modifierScreen(undefined);
      const started = Date.now();
      await expect(screen.getByLabel('Missing').secondaryTap({ modifiers: ['Alt'] })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
      });
      expect(Date.now() - started).toBeLessThan(500);
    });

    it.each([
      [invalid<readonly KeyModifier[]>(['Hyper']), /modifier "Hyper" is not one of Shift, Control, Alt, Meta, ControlOrMeta/],
      [invalid<readonly KeyModifier[]>('Shift'), /modifiers must be an array/],
      [['Shift', 'Shift'] as const, /names a modifier twice/],
    ])('rejects modifiers %j before any lookup', async (modifiers, message) => {
      const { screen, received } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(message) });
      expect(received).toEqual([]);
    });

    it('quotes a modifier JSON cannot serialize without throwing its own error', async () => {
      const { screen } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers: invalid<readonly KeyModifier[]>([1n]) })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('modifier a bigint is not one of') });
    });

    it('refuses modifiers with a position, which the pointer path cannot hold yet', async () => {
      const { screen } = modifierScreen(true);
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ modifiers: ['Shift'], position: { x: 1, y: 1 } })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('modifiers with a position') });
    });
  });

  describe('tap count', () => {
    /** A screen over the box whose engine declares `actions`, keeping every action it receives. */
    function countScreen(actions?: readonly LocatorActionKind[], tapModifiers?: boolean) {
      const received: LocatorAction[] = [];
      const locate = vi.fn(async (expression: LocatorExpression) => resolveExpression(expression, NODES));
      const { screen, steps } = screenOver({
        locate,
        observe: () => snapshot(NODES),
        perform: (_ref, action) => {
          received.push(action);
        },
        ...(actions === undefined ? {} : { actions }),
        ...(tapModifiers === undefined ? {} : { tapModifiers }),
        timeoutMs: 1_000,
      });
      return { screen, steps, received, locate };
    }

    it('taps once for count 1, as with no count', async () => {
      const { screen, steps, received } = countScreen();
      await screen.getByLabel('Agree').tap({ count: 1 });
      await screen.getByLabel('Agree').click({ count: 1 });
      expect(received).toEqual([{ kind: 'tap' }, { kind: 'tap' }]);
      expect(steps.all().map((step) => step.label)).toEqual(['getByLabel("Agree")', 'getByLabel("Agree")']);
    });

    it('sends count 2 as the action doubleTap() sends, labelled with the count', async () => {
      const { screen, steps, received } = countScreen(LOCATOR_ACTION_KINDS);
      await screen.getByLabel('Agree').tap({ count: 2 });
      await screen.getByLabel('Agree').doubleTap();
      expect(received).toEqual([{ kind: 'doubleTap' }, { kind: 'doubleTap' }]);
      expect(steps.all()).toEqual([
        expect.objectContaining({ api: 'locator.tap', label: 'getByLabel("Agree") 2 times', status: 'passed' }),
        expect.objectContaining({ api: 'locator.doubleTap', label: 'getByLabel("Agree")', status: 'passed' }),
      ]);
    });

    it.each([
      ['tap', (locator: Locator) => locator.tap({ count: 3 })],
      ['click', (locator: Locator) => locator.click({ count: 3 })],
    ] as const)('%s sends count 3 as one multiTap and names the count in the step', async (verb, call) => {
      const { screen, steps, received } = countScreen();
      await call(screen.getByLabel('Agree'));
      expect(received).toEqual([{ kind: 'multiTap', count: 3 }]);
      expect(steps.all()).toEqual([
        expect.objectContaining({ api: `locator.${verb}`, label: 'getByLabel("Agree") 3 times', status: 'passed' }),
      ]);
    });

    it('holds modifiers for a multiTap on an engine that declares tapModifiers', async () => {
      const { screen, steps, received } = countScreen(undefined, true);
      await screen.getByLabel('Agree').tap({ count: 3, modifiers: ['Shift'] });
      await screen.getByLabel('Agree').tap({ count: 2, modifiers: ['Shift'] });
      expect(received).toEqual([
        { kind: 'multiTap', count: 3, modifiers: ['Shift'] },
        { kind: 'doubleTap', modifiers: ['Shift'] },
      ]);
      expect(steps.all().map((step) => step.label)).toEqual([
        'getByLabel("Agree") 3 times with Shift',
        'getByLabel("Agree") 2 times with Shift',
      ]);
    });

    it('refuses count 3 on an engine without multiTap before resolving, while count 2 still works there', async () => {
      const { screen, received, locate } = countScreen(LOCATOR_ACTION_KINDS);
      await expect(screen.getByLabel('Missing').tap({ count: 3 })).rejects.toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('the "multiTap" action is not available on this target'),
      });
      expect(locate).not.toHaveBeenCalled();
      await screen.getByLabel('Agree').tap({ count: 2 });
      expect(received).toEqual([{ kind: 'doubleTap' }]);
    });

    it('leaves the upper limit to the engine, sending the largest safe count as one multiTap', async () => {
      const { screen, received } = countScreen();
      await screen.getByLabel('Agree').tap({ count: Number.MAX_SAFE_INTEGER });
      expect(received).toEqual([{ kind: 'multiTap', count: Number.MAX_SAFE_INTEGER }]);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3', null])(
      'rejects count %j before any lookup, action, or step',
      async (count) => {
        const { screen, steps, received, locate } = countScreen();
        await expect(
          Promise.resolve().then(() => screen.getByLabel('Agree').tap(invalid<TapOptions>({ count }))),
        ).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: expect.stringMatching(/^tap\(\) count must be a positive safe integer, got /),
        });
        expect(locate).not.toHaveBeenCalled();
        expect(received).toEqual([]);
        expect(steps.all()).toEqual([]);
      },
    );

    it('refuses a count above 1 with a position, which the pointer path cannot repeat yet', async () => {
      const { screen, received } = countScreen();
      await expect(
        Promise.resolve().then(() => screen.getByLabel('Agree').tap({ count: 2, position: { x: 1, y: 1 } })),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('count with a position') });
      expect(received).toEqual([]);
    });

    it('still taps at the point for count 1 with a position, the default count', async () => {
      const box = { ...BOX, rect: { x: 10, y: 20, width: 100, height: 40 } };
      const received: LocatorAction[] = [];
      const at: string[] = [];
      const { screen, steps } = screenOver({
        locate: async (expression) => resolveExpression(expression, [box]),
        observe: () => snapshot([box]),
        perform: (_ref, action) => {
          received.push(action);
        },
        performAt: (point, action) => {
          at.push(`${action.kind} @ ${point.x},${point.y}`);
        },
        timeoutMs: 1_000,
      });
      await screen.getByLabel('Agree').tap({ count: 1, position: { x: 1, y: 1 } });
      expect(at).toEqual(['tap @ 11,21']);
      expect(received.filter((action) => action.kind !== 'scrollIntoView')).toEqual([]);
      expect(steps.all()).toEqual([
        expect.objectContaining({ api: 'locator.tap', label: 'getByLabel("Agree") at (1, 1)', status: 'passed' }),
      ]);
    });
  });

  it('longPress sends a duration from 100 through 10000 and none when unset, so the engine default holds', async () => {
    const { screen, actions } = boxScreen();
    const box = screen.getByLabel('Agree');
    await box.longPress();
    await box.longPress({ duration: 100 });
    await box.longPress({ duration: 10_000 });
    expect(actions).toEqual([{ kind: 'longPress' }, { kind: 'longPress', durationMs: 100 }, { kind: 'longPress', durationMs: 10_000 }]);
    expect(Object.hasOwn(actions[0]!, 'durationMs')).toBe(false);
  });

  it.each([99, 10_001, 1.5, null])('longPress refuses a duration of %s before any action', async (duration) => {
    const { screen, performed } = boxScreen();
    await expect(Promise.resolve().then(() => screen.getByLabel('Agree').longPress({ duration: invalid<number>(duration) }))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('longPress duration must be an integer from 100 through 10000'),
    });
    expect(performed).toEqual([]);
  });

  it('setInputFiles hands an empty list to the engine, which clears the input', async () => {
    const { screen, steps, actions } = boxScreen();
    await screen.getByLabel('Agree').setInputFiles([]);
    expect(actions).toEqual([{ kind: 'setInputFiles', paths: [] }]);
    expect(steps.all()).toEqual([expect.objectContaining({ api: 'locator.setInputFiles', status: 'passed' })]);
  });

  it('rejects payload size at or above 50 MiB before lookup, dispatch, or recording', async () => {
    const { screen, actions, steps, locate } = boxScreen();
    const limit = 50 * 1024 * 1024;
    const buffer = Buffer.alloc(limit + 1);
    const file = { name: 'large.bin', mimeType: 'application/octet-stream', buffer };
    for (const files of [
      { ...file, buffer: buffer.subarray(0, limit) },
      file,
      [{ ...file, buffer: buffer.subarray(0, limit / 2) }, { ...file, buffer: buffer.subarray(limit / 2, limit) }],
    ]) {
      await expect(Promise.resolve().then(() => screen.getByLabel('Agree').setInputFiles(files))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Cannot set buffer larger than 50Mb, please write it to a file and pass its path instead.',
      });
    }
    expect(locate).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
    expect(steps.all()).toEqual([]);
  });

  it('accepts payload size just below 50 MiB', async () => {
    const { screen, actions } = boxScreen();
    await screen.getByLabel('Agree').setInputFiles({
      name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(50 * 1024 * 1024 - 1),
    });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action?.kind).toBe('setInputFilePayloads');
    if (action?.kind === 'setInputFilePayloads') expect(action.files[0]?.buffer.byteLength).toBe(50 * 1024 * 1024 - 1);
  });

  it('rejects mixed file paths and buffers in either order', async () => {
    const { screen, actions, locate } = boxScreen();
    const file = { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') };
    for (const files of [[file, 'a.txt'], ['a.txt', file]]) {
      await expect(Promise.resolve().then(() => screen.getByLabel('Agree').setInputFiles(
        invalid<Parameters<Locator['setInputFiles']>[0]>(files),
      ))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: 'File paths cannot be mixed with buffers' });
    }
    expect(locate).not.toHaveBeenCalled();
    expect(actions).toEqual([]);
  });

  it('snapshots single files and arrays as bytes without putting contents in steps', async () => {
    const { screen, steps, actions } = boxScreen();
    const file = { name: 'receipt.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 128, 255]) };
    const pending = screen.getByLabel('Agree').setInputFiles(file);
    file.buffer[0] = 99;
    await pending;
    file.buffer[0] = 0;
    await screen.getByLabel('Agree').setInputFiles([file, { ...file, name: 'empty.bin', buffer: Buffer.alloc(0) }]);
    const encoded = { name: file.name, mimeType: file.mimeType, buffer: new Uint8Array([0, 128, 255]) };
    expect(actions).toEqual([
      { kind: 'setInputFilePayloads', files: [encoded] },
      { kind: 'setInputFilePayloads', files: [encoded, { ...encoded, name: 'empty.bin', buffer: new Uint8Array() }] },
    ]);
    file.buffer[0] = 99;
    const action = actions[0];
    if (action?.kind === 'setInputFilePayloads') expect(action.files[0]?.buffer).toEqual(new Uint8Array([0, 128, 255]));
    expect(JSON.stringify(steps.all())).not.toContain('AID/');
  });

  it('uploads then clears on a payload-only engine', async () => {
    const perform = vi.fn(async () => undefined);
    const { screen } = screenOver({
      actions: ['setInputFilePayloads'],
      locate: async () => [BOX],
      observe: () => snapshot(NODES),
      perform,
      timeoutMs: 1_000,
    });
    const input = screen.getByLabel('Agree');
    await input.setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') });
    await expect(input.setInputFiles('a.txt')).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(perform).toHaveBeenCalledTimes(1);
    await input.setInputFiles([]);
    expect(perform.mock.calls).toHaveLength(2);
    expect(perform).toHaveBeenNthCalledWith(2, expect.anything(), { kind: 'setInputFilePayloads', files: [] }, expect.anything());
  });

  it.each([{ actions: ['setInputFiles'] as const }, { actions: LOCATOR_ACTION_KINDS }])('rejects payload uploads when the engine declares no payload action', async ({ actions }) => {
    const locate = vi.fn(async () => [BOX]);
    const perform = vi.fn(async () => undefined);
    const { screen } = screenOver({ locate, perform, actions, observe: () => snapshot(NODES), timeoutMs: 1_000 });
    await expect(screen.getByLabel('Agree').setInputFiles({
      name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('data'),
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'in-memory files for setInputFiles are not available on this target; update its engine or pass a file path',
    });
    expect(locate).not.toHaveBeenCalled();
    expect(perform).not.toHaveBeenCalled();
    await screen.getByLabel('Agree').setInputFiles('a.txt');
    expect(perform).toHaveBeenCalledWith(expect.anything(), { kind: 'setInputFiles', paths: ['a.txt'] }, expect.anything());
  });

  it('does not suggest file paths when the engine supports no uploads', async () => {
    const locate = vi.fn(async () => [BOX]);
    const perform = vi.fn(async () => undefined);
    const { screen } = screenOver({ locate, perform, actions: ['tap'], observe: () => snapshot(NODES), timeoutMs: 1_000 });
    await expect(screen.getByLabel('Agree').setInputFiles({
      name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('data'),
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'in-memory files for setInputFiles are not available on this target; update its engine',
    });
    await expect(screen.getByLabel('Agree').setInputFiles([])).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: 'the "setInputFiles" action is not available on this target: its engine declares tap',
    });
    expect(locate).not.toHaveBeenCalled();
    expect(perform).not.toHaveBeenCalled();
  });

  it.each([
    null, 42, {}, Object.assign([], { length: 1 }), { name: '', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: 'a.txt', buffer: Buffer.alloc(0) },
    { name: 'a.txt', mimeType: 'text/plain', buffer: new Uint8Array([1]) },
    { name: 'a.txt', mimeType: 'text/plain', buffer: 'not bytes' },
    [{ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }, 'a.txt'],
    { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0), typo: true },
  ])('refuses invalid file payload %j before lookup or recording', async (files) => {
    const { screen, steps, actions, locate } = boxScreen();
    await expect(Promise.resolve().then(() => screen.getByLabel('Agree').setInputFiles(
      invalid<Parameters<Locator['setInputFiles']>[0]>(files),
    ))).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(actions).toEqual([]);
    expect(locate).not.toHaveBeenCalled();
    expect(steps.all()).toEqual([]);
  });

  it.each([[''], ['  '], [['fixtures/a.txt', '']], [invalid<readonly string[]>(['fixtures/a.txt', 1])]])(
    'setInputFiles refuses %j before any lookup or action',
    async (paths) => {
      const { screen, steps, performed, locate } = boxScreen();
      await expect(Promise.resolve().then(() => screen.getByLabel('Agree').setInputFiles(paths))).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'setInputFiles paths must be non-empty strings',
      });
      expect(locate).not.toHaveBeenCalled();
      expect(performed).toEqual([]);
      expect(steps.all()).toEqual([]);
    },
  );
});
