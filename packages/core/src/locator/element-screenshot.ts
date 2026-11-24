/** `locator.screenshot()`: the engine's screenshot of the screen, cut to one match's box. */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocatorExpression, SemanticNode, ViewportSize } from '../engine/surface.ts';
import { asEngineError, ConfigurationError, isE2EError, TestError } from '../internal/errors.ts';
import { clipBox, cropImage, decodePng, encodePng, type RgbaImage } from '../internal/image.ts';
import { pollReads, type ReadWindow } from '../internal/time.ts';
import { isNodeVisible, locatorDetails, translateLocatorError, type LocatorEngine } from './engine.ts';
import { describeExpression } from './expression.ts';

type Box = NonNullable<SemanticNode['rect']>;

/**
 * Captures exactly one match and returns the file's path relative to
 * `artifactsDir`, as the engine named it. The match is scrolled into view
 * when the engine can, then the engine's screenshot of the screen is cut to
 * the part of the match's box inside the viewport, at the screenshot's own
 * pixel density. The box and the viewport are read before and after the
 * capture, and a capture either changed during is thrown away and taken
 * again, so the file never shows the wrong part of the screen. A match a
 * layout shift pushed out of the viewport is scrolled back. No capture is
 * taken of a match with nothing inside the viewport, and none outlives a
 * round that did not keep it. The engine's screenshot has to be a PNG of
 * the viewport.
 */
export async function captureMatch(
  engine: LocatorEngine,
  artifactsDir: string,
  expression: LocatorExpression,
  label: string | undefined,
): Promise<string> {
  const deadline = engine.deadline();
  const scrolls = engine.session.actions.has('scrollIntoView');
  if (scrolls) await engine.performUntil(expression, { kind: 'scrollIntoView' }, deadline);
  const shown = describeExpression(expression);
  let kept: string | undefined;
  let missing = `locator did not become visible with a box to capture: ${shown}`;
  const boxOf = async (reads: ReadWindow): Promise<Box | undefined> => {
    const { node } = await engine.tryRead(expression, reads);
    return isNodeVisible(node) ? node.rect : undefined;
  };
  const viewportOf = async (reads: ReadWindow): Promise<ViewportSize> =>
    (await reads.read((timeoutMs) => engine.session.observe(engine.readOperation(timeoutMs)))).viewport;
  await pollReads({
    deadline,
    signal: engine.signal,
    negated: false,
    reads: engine.reads(deadline),
    evaluate: async (reads) => {
      // A round started at the deadline could not finish: skip it so the wait ends with the reason it has.
      if (deadline.expired()) return false;
      let file: string | undefined;
      try {
        const before = await boxOf(reads);
        if (before === undefined) return false;
        const viewport = await viewportOf(reads);
        if (visiblePart(before, viewport) === undefined) {
          missing = `locator is outside the viewport, so it has no pixels to capture: ${shown}`;
          // The page moved the match out after the first scroll, as a banner arriving above it does.
          if (scrolls && !deadline.expired()) await engine.performUntil(expression, { kind: 'scrollIntoView' }, deadline);
          return false;
        }
        if (deadline.expired()) return false;
        const relative = await engine.session.artifacts.screenshot(label, engine.operationWithin(deadline));
        file = path.join(artifactsDir, relative);
        const after = await boxOf(reads);
        const settled = await viewportOf(reads);
        if (after === undefined || !sameBox(before, after) || settled.width !== viewport.width || settled.height !== viewport.height) {
          missing = `locator or the viewport kept moving while its screenshot was taken: ${shown}`;
          return false;
        }
        const image = decodeScreenshot(file);
        // One scale for both axes, from the width, as the engines place their own masks.
        const scale = image.width / viewport.width;
        const visible = visiblePart(after, viewport);
        const box = visible === undefined ? undefined : clipBox(image, { x: visible.x * scale, y: visible.y * scale, width: visible.width * scale, height: visible.height * scale });
        if (box === undefined) {
          missing = `locator is outside the screenshot the engine took, so it has no pixels to capture: ${shown}`;
          return false;
        }
        writeFileSync(file, encodePng(cropImage(image, box)));
        // The engine's own spelling, with `/`: the report takes no other separator.
        kept = relative;
        return true;
      } catch (cause) {
        // A document replaced mid-round is read again on the next one, as a stale node is.
        if (asEngineError(cause)?.retryable === true && !deadline.expired()) return false;
        throw translateLocatorError(cause, expression);
      } finally {
        if (file !== undefined && kept === undefined) rmSync(file, { force: true });
      }
    },
    onTimeout: (cause) =>
      new TestError('LOCATOR_NOT_FOUND', missing, {
        details: locatorDetails(expression, deadline.elapsed()),
        ...(cause === undefined ? {} : { cause }),
      }),
  });
  // pollReads returns only once `evaluate` answered true, which set `kept`.
  return kept!;
}

/** The engine's screenshot as pixels. An engine may write another format, which `app.screenshot()` passes on and a crop cannot read. */
function decodeScreenshot(file: string): RgbaImage {
  const bytes = readFileSync(file);
  try {
    return decodePng(bytes);
  } catch (cause) {
    if (isE2EError(cause)) throw cause;
    throw new ConfigurationError('UNSUPPORTED_CAPABILITY', 'locator.screenshot() cuts a PNG of the viewport, and this engine\'s screenshot is not one', { cause });
  }
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** The part of `box` inside a viewport of `size`, in the viewport's units; undefined when none of it is. */
function visiblePart(box: Box, size: ViewportSize): Box | undefined {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  const width = Math.min(size.width, box.x + box.width) - x;
  const height = Math.min(size.height, box.y + box.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}
