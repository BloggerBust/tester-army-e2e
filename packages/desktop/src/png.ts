/** Screenshot masking: a window capture decoded with @napi-rs/image, cropped to the window, its secure regions painted black, encoded again; the layout code turns the addon's pixels into 8-bit RGBA. */
import { endianness } from 'node:os';
import { FilterType, JsColorType, Transformer } from '@napi-rs/image';
import type { Rect } from './nodes.ts';

const LITTLE_ENDIAN = endianness() === 'LE';

/** Channels per pixel, and whether each is a 16-bit sample, for every color type a decode reads: 8-bit RGB is widened by the addon before that. */
const LAYOUTS: Readonly<Partial<Record<JsColorType, { readonly channels: number; readonly wide: boolean }>>> = {
  [JsColorType.L8]: { channels: 1, wide: false },
  [JsColorType.La8]: { channels: 2, wide: false },
  [JsColorType.Rgba8]: { channels: 4, wide: false },
  [JsColorType.L16]: { channels: 1, wide: true },
  [JsColorType.La16]: { channels: 2, wide: true },
  [JsColorType.Rgb16]: { channels: 3, wide: true },
  [JsColorType.Rgba16]: { channels: 4, wide: true },
};

/** An 8-bit RGBA image, rows top to bottom. */
export interface Rgba {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** How far, in image pixels, the window in a capture may differ from the size its bounds give: points times scale, rounded. */
const SIZE_TOLERANCE = 1;

/** How far each mask reaches past its field, in image pixels, so a field off by the tolerance is still covered. */
const MASK_MARGIN = 2;

/**
 * The window's own pixels out of a window capture, every rectangle (in the
 * window's image pixels) painted opaque black. macOS draws the window's
 * shadow into the capture, unevenly on each side, so the window is found as
 * the box of fully opaque pixels, which the shadow never is, and cropped to.
 * A capture within a pixel of `expected` (the window's size in image
 * pixels) is the window already; any other is cropped to its opaque box,
 * which must then be within a pixel of it. Undefined otherwise: the
 * rectangles would land somewhere else, and an image whose masking cannot
 * be proven must not leave the engine.
 */
export function windowImage(bytes: Uint8Array, expected: { width: number; height: number }, rects: readonly Rect[]): Rgba | undefined {
  const image = decodeRgba(bytes);
  const fits = (width: number, height: number): boolean =>
    Math.abs(width - expected.width) <= SIZE_TOLERANCE && Math.abs(height - expected.height) <= SIZE_TOLERANCE;
  let window = image;
  if (!fits(image.width, image.height)) {
    const box = opaqueBox(image);
    if (box === undefined || !fits(box.width, box.height)) return undefined;
    window = crop(image, box);
  }
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x) - MASK_MARGIN);
    const y0 = Math.max(0, Math.floor(rect.y) - MASK_MARGIN);
    const x1 = Math.min(window.width, Math.ceil(rect.x + rect.width) + MASK_MARGIN);
    const y1 = Math.min(window.height, Math.ceil(rect.y + rect.height) + MASK_MARGIN);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * window.width + x) * 4;
        window.data[at] = 0;
        window.data[at + 1] = 0;
        window.data[at + 2] = 0;
        window.data[at + 3] = 255;
      }
    }
  }
  return window;
}

/** PNG bytes of an image. */
export function encodePng(image: Rgba): Uint8Array {
  return encodeRgba(image);
}

/** The smallest box holding every fully opaque pixel; undefined when there is none. */
function opaqueBox(image: Rgba): { x: number; y: number; width: number; height: number } | undefined {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] !== 255) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  return right < 0 ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function crop(image: Rgba, box: { x: number; y: number; width: number; height: number }): Rgba {
  const data = new Uint8Array(box.width * box.height * 4);
  for (let row = 0; row < box.height; row += 1) {
    const from = ((box.y + row) * image.width + box.x) * 4;
    data.set(image.data.subarray(from, from + box.width * 4), row * box.width * 4);
  }
  return { width: box.width, height: box.height, data };
}

/**
 * Decodes PNG bytes to 8-bit RGBA, whatever the color type, bit depth, or
 * palette; throws on bytes that are not a PNG. An 8-bit RGB screenshot is
 * widened by the addon: opacity 1 keeps every sample and adds the opaque
 * alpha channel, several times faster than `spread` does it.
 */
function decodeRgba(bytes: Uint8Array): Rgba {
  const decoder = new Transformer(bytes);
  const { width, height, format, colorType } = decoder.metadataSync();
  if (format !== 'png') throw new Error(`not a PNG: the bytes are ${format}`);
  const rgb = colorType === JsColorType.Rgb8;
  const raw = (rgb ? decoder.opacity(1) : decoder).rawPixelsSync();
  const layout = LAYOUTS[rgb ? JsColorType.Rgba8 : colorType];
  if (layout === undefined) throw new Error(`unsupported PNG color type ${colorType}`);
  const { channels, wide } = layout;
  if (raw.length !== width * height * channels * (wide ? 2 : 1)) throw new Error('the decoded PNG pixels do not fill its size');
  const samples = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (channels === 4 && !wide) return { width, height, data: samples };
  return { width, height, data: spread(wide ? narrow(samples) : samples, channels, width * height) };
}

/**
 * Encodes an image as PNG bytes, each row adaptively filtered: the addon's
 * default writes no filter, which makes screenshots markedly larger.
 */
function encodeRgba(image: Rgba): Uint8Array {
  const png = Transformer.fromRgbaPixels(image.data, image.width, image.height).pngSync({ filterType: FilterType.Adaptive });
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

/** 16-bit samples in native byte order as 8-bit samples, rounded. */
function narrow(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Uint8Array(bytes.length / 2);
  for (let at = 0; at < samples.length; at += 1) samples[at] = Math.round((view.getUint16(at * 2, LITTLE_ENDIAN) * 255) / 65535);
  return samples;
}

/** 8-bit samples of `channels` per pixel (gray, gray and alpha, RGB) as RGBA; a gray or RGB image is opaque. */
function spread(samples: Uint8Array, channels: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  const gray = channels <= 2;
  const alpha = channels === 2 || channels === 4;
  for (let pixel = 0, from = 0, to = 0; pixel < pixels; pixel += 1, from += channels, to += 4) {
    const r = samples[from]!;
    out[to] = r;
    out[to + 1] = gray ? r : samples[from + 1]!;
    out[to + 2] = gray ? r : samples[from + 2]!;
    out[to + 3] = alpha ? samples[from + channels - 1]! : 255;
  }
  return out;
}
