/**
 * `locator.screenshot()` cuts the engine's screenshot of the screen to the
 * one match's box, at the screenshot's own pixel density, and never keeps a
 * capture the match moved during.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineError, resolveExpression, type SemanticNode } from '@e2e-dev/core/lib/engine/index';
import { decodePng, encodePng, type RgbaImage } from '@e2e-dev/core/lib/internal/image';
import type { Locator } from '@e2e-dev/core/lib/types';
import { screenOver } from '../helpers/screen-over.ts';
import { snapshot } from '../helpers/snapshot.ts';

const VIEWPORT = { width: 100, height: 50 };
const RED = [255, 0, 0, 255] as const;
const WHITE = [255, 255, 255, 255] as const;

let artifactsDir: string;
beforeEach(() => {
  artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-locator-screenshot-'));
  mkdirSync(path.join(artifactsDir, 'screenshots'));
});
afterEach(() => {
  rmSync(artifactsDir, { recursive: true, force: true });
});

function card(rect: NonNullable<SemanticNode['rect']>): SemanticNode {
  return { ref: { id: 'card', revision: '' }, role: 'group', name: 'Card', testId: 'card', rect };
}

/** The viewport at `scale` image pixels per viewport pixel, white, with `box` (in viewport pixels) red. */
function screenImage(scale: number, box: NonNullable<SemanticNode['rect']>): RgbaImage {
  const width = VIEWPORT.width * scale;
  const height = VIEWPORT.height * scale;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= box.x * scale && x < (box.x + box.width) * scale && y >= box.y * scale && y < (box.y + box.height) * scale;
      data.set(inside ? RED : WHITE, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** A screen whose engine writes `image` for every screenshot, and whose one node is whatever `node` answers at each read, given the captures so far. */
function screenWith(
  image: RgbaImage,
  node: (captures: number) => SemanticNode,
  timeoutMs = 2_000,
  observed: (captures: number) => void = () => undefined,
  registered: (relativePath: string) => void = () => undefined,
): { card: Locator; captures: () => number } {
  let captures = 0;
  const { screen } = screenOver({
    locate: (expression) => resolveExpression(expression, [node(captures)]),
    observe: () => {
      observed(captures);
      return snapshot([node(captures)], { viewport: VIEWPORT });
    },
    perform: () => undefined,
    screenshot: (label) => {
      captures += 1;
      const relative = `screenshots/${String(captures).padStart(3, '0')}${label === undefined ? '' : `-${label}`}.png`;
      writeFileSync(path.join(artifactsDir, relative), encodePng(image));
      return relative;
    },
    artifactsDir,
    registered,
    timeoutMs,
  });
  return { card: screen.getByTestId('card'), captures: () => captures };
}

/** Whether every pixel of the image is `color`. */
function isAll(image: RgbaImage, color: readonly number[]): boolean {
  for (let at = 0; at < image.data.length; at += 4) {
    if (color.some((channel, index) => image.data[at + index] !== channel)) return false;
  }
  return true;
}

describe('locator.screenshot', () => {
  it('keeps the match and nothing around it, and returns the absolute path', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { card: locator } = screenWith(screenImage(1, box), () => card(box));
    const file = await locator.screenshot('card');
    expect(file).toBe(path.join(artifactsDir, 'screenshots', '001-card.png'));
    const image = decodePng(readFileSync(file));
    expect({ width: image.width, height: image.height }).toEqual({ width: 30, height: 15 });
    expect(isAll(image, RED)).toBe(true);
  });

  it('cuts at the density of the screenshot, not of the box', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { card: locator } = screenWith(screenImage(2, box), () => card(box));
    const image = decodePng(readFileSync(await locator.screenshot()));
    expect({ width: image.width, height: image.height }).toEqual({ width: 60, height: 30 });
    expect(isAll(image, RED)).toBe(true);
  });

  it('keeps the part inside the viewport of a match larger than it', async () => {
    const box = { x: 80, y: 40, width: 50, height: 50 };
    const { card: locator } = screenWith(screenImage(1, box), () => card(box));
    const image = decodePng(readFileSync(await locator.screenshot()));
    expect({ width: image.width, height: image.height }).toEqual({ width: 20, height: 10 });
  });

  it('takes the capture again when the match moved during it, and keeps one file', async () => {
    const settled = { x: 10, y: 20, width: 30, height: 15 };
    // The box moves during the first capture, then holds.
    const { card: locator, captures } = screenWith(screenImage(1, settled), (taken) => card(taken === 0 ? { ...settled, y: 0 } : settled));
    const file = await locator.screenshot();
    expect(captures()).toBe(2);
    expect(readdirSync(path.join(artifactsDir, 'screenshots'))).toEqual([path.basename(file)]);
    expect(isAll(decodePng(readFileSync(file)), RED)).toBe(true);
  });

  it('fails as LOCATOR_NOT_FOUND, naming why, for a match outside the viewport, and captures nothing', async () => {
    const box = { x: 500, y: 500, width: 30, height: 15 };
    const { card: locator, captures } = screenWith(screenImage(1, box), () => card(box), 300);
    await expect(locator.screenshot()).rejects.toMatchObject({
      code: 'LOCATOR_NOT_FOUND',
      message: expect.stringContaining('is outside the viewport'),
    });
    expect(captures()).toBe(0);
  });

  it('scales both axes by the width, as the engines place their masks', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    // Twice the viewport across, and taller than twice: a bar the viewport does not count.
    const image = screenImage(2, box);
    const taller: RgbaImage = { width: image.width, height: image.height + 20, data: new Uint8Array([...image.data, ...new Uint8Array(image.width * 20 * 4).fill(255)]) };
    const { card: locator } = screenWith(taller, () => card(box));
    const cut = decodePng(readFileSync(await locator.screenshot()));
    expect({ width: cut.width, height: cut.height }).toEqual({ width: 60, height: 30 });
    expect(isAll(cut, RED)).toBe(true);
  });

  it('leaves no file behind when the round fails after the capture', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { card: locator, captures } = screenWith(screenImage(1, box), (taken) => {
      if (taken > 0) throw new EngineError('ENGINE_FAILURE', 'the engine lost the screen', { retryable: false });
      return card(box);
    });
    await expect(locator.screenshot()).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    expect(captures()).toBe(1);
    expect(readdirSync(path.join(artifactsDir, 'screenshots'))).toEqual([]);
  });

  it('takes the round again when the document was replaced during it', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    let observations = 0;
    const { card: locator } = screenWith(screenImage(1, box), () => card(box), 2_000, () => {
      observations += 1;
      if (observations === 1) throw new EngineError('NODE_STALE', 'the document was replaced', { retryable: true });
    });
    expect(isAll(decodePng(readFileSync(await locator.screenshot())), RED)).toBe(true);
    // One that threw, then the viewport before and after the kept capture.
    expect(observations).toBe(3);
  });

  it('cuts the part inside the viewport when the screenshot shows more than the viewport', async () => {
    // A 100 by 50 viewport at 2x, with 20 more image rows below it; the card's lower 30 rows are outside the viewport.
    const box = { x: 10, y: 40, width: 20, height: 40 };
    const image = screenImage(2, box);
    const taller: RgbaImage = { width: image.width, height: image.height + 20, data: new Uint8Array([...image.data, ...new Uint8Array(image.width * 20 * 4).fill(255)]) };
    const { card: locator } = screenWith(taller, () => card(box));
    const cut = decodePng(readFileSync(await locator.screenshot()));
    expect({ width: cut.width, height: cut.height }).toEqual({ width: 40, height: 20 });
  });

  it('takes the capture again when the viewport changed size during it', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    let captures = 0;
    // The first capture is taken as the window doubles: its pixels belong to neither size.
    const viewport = (): { width: number; height: number } => (captures === 0 ? VIEWPORT : { width: 200, height: 100 });
    const { screen } = screenOver({
      locate: (expression) => resolveExpression(expression, [card(box)]),
      observe: () => snapshot([card(box)], { viewport: viewport() }),
      perform: () => undefined,
      screenshot: () => {
        captures += 1;
        const relative = `screenshots/${String(captures).padStart(3, '0')}.png`;
        writeFileSync(path.join(artifactsDir, relative), encodePng(screenImage(captures === 1 ? 2 : 1, captures === 1 ? box : { x: 5, y: 10, width: 15, height: 7.5 })));
        return relative;
      },
      artifactsDir,
      timeoutMs: 2_000,
    });
    const file = await screen.getByTestId('card').screenshot();
    expect(captures).toBe(2);
    expect(readdirSync(path.join(artifactsDir, 'screenshots'))).toEqual([path.basename(file)]);
    const cut = decodePng(readFileSync(file));
    // The kept capture is the settled one: 100 image pixels across a 200 wide viewport, so the 30 by 15 box is 15 by 8.
    expect({ width: cut.width, height: cut.height }).toEqual({ width: 15, height: 8 });
  });

  it('scrolls the match back when the page moved it out of the viewport after the first scroll', async () => {
    const inView = { x: 10, y: 20, width: 30, height: 15 };
    let scrolls = 0;
    // The first scroll lands, then a banner pushes the card below the viewport; the second scroll brings it back.
    const box = (): typeof inView => (scrolls === 1 ? { ...inView, y: 400 } : inView);
    let captures = 0;
    const { screen } = screenOver({
      locate: (expression) => resolveExpression(expression, [card(box())]),
      observe: () => snapshot([card(box())], { viewport: VIEWPORT }),
      perform: (_ref, action) => {
        if (action.kind === 'scrollIntoView') scrolls += 1;
      },
      screenshot: () => {
        captures += 1;
        writeFileSync(path.join(artifactsDir, 'screenshots', 'shot.png'), encodePng(screenImage(1, inView)));
        return 'screenshots/shot.png';
      },
      artifactsDir,
      timeoutMs: 2_000,
    });
    expect(isAll(decodePng(readFileSync(await screen.getByTestId('card').screenshot())), RED)).toBe(true);
    expect(scrolls).toBe(2);
    expect(captures).toBe(1);
  });

  it('returns the path the engine named, joined to the artifacts directory', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const registered: string[] = [];
    const { card: locator } = screenWith(screenImage(1, box), () => card(box), 2_000, () => undefined, (relative) => registered.push(relative));
    const file = await locator.screenshot('card');
    // The report takes `/` only, whatever the platform joins with.
    expect(registered).toEqual(['screenshots/001-card.png']);
    expect(file).toBe(path.join(artifactsDir, 'screenshots', '001-card.png'));
  });

  it('says so when the engine\'s screenshot is not a PNG', async () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { screen } = screenOver({
      locate: (expression) => resolveExpression(expression, [card(box)]),
      observe: () => snapshot([card(box)], { viewport: VIEWPORT }),
      perform: () => undefined,
      screenshot: () => {
        writeFileSync(path.join(artifactsDir, 'screenshots', 'shot.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
        return 'screenshots/shot.jpg';
      },
      artifactsDir,
      timeoutMs: 2_000,
    });
    await expect(screen.getByTestId('card').screenshot()).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('cuts a PNG of the viewport'),
    });
    expect(readdirSync(path.join(artifactsDir, 'screenshots'))).toEqual([]);
  });

  it('refuses anything but a label before it captures', () => {
    const box = { x: 10, y: 20, width: 30, height: 15 };
    const { card: locator, captures } = screenWith(screenImage(1, box), () => card(box));
    expect(() => locator.screenshot({ path: 'card.png' } as unknown as string)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(captures()).toBe(0);
  });
});
