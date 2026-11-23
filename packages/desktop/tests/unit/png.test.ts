import { Transformer } from '@napi-rs/image';
import { describe, expect, it } from 'vitest';
import { encodePng, windowImage } from '../../src/png.ts';

/** A capture as macOS takes it: the opaque window inside a half-transparent shadow. */
function capture(width: number, height: number, window: { x: number; y: number; width: number; height: number }): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= window.x && x < window.x + window.width && y >= window.y && y < window.y + window.height;
      const at = (y * width + x) * 4;
      data.set(inside ? [200, 200, 200, 255] : [0, 0, 0, 90], at);
    }
  }
  const png = Transformer.fromRgbaPixels(data, width, height).pngSync();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

function pixel(image: { width: number; data: Uint8Array }, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.data.subarray(at, at + 4)];
}

describe('windowImage', () => {
  it('crops the shadow off and masks in window coordinates', () => {
    const image = windowImage(capture(30, 24, { x: 6, y: 3, width: 16, height: 10 }), { width: 16, height: 10 }, [{ x: 2, y: 2, width: 4, height: 3 }]);
    expect(image).toMatchObject({ width: 16, height: 10 });
    expect(pixel(image!, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 10, 8)).toEqual([200, 200, 200, 255]);
    expect(encodePng(image!).subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
  });

  it('takes a capture with no shadow as the window', () => {
    const image = windowImage(capture(16, 10, { x: 0, y: 0, width: 16, height: 10 }), { width: 16, height: 10 }, []);
    expect(image).toMatchObject({ width: 16, height: 10 });
  });

  it('withholds a capture with a border, rather than mask it in the wrong place', () => {
    const bordered = capture(12, 10, { x: 0, y: 0, width: 12, height: 10 });
    expect(windowImage(bordered, { width: 10, height: 10 }, [{ x: 7, y: 2, width: 3, height: 3 }])).toBeUndefined();
  });

  it('covers a field off by a pixel of rounding', () => {
    const image = windowImage(capture(16, 10, { x: 0, y: 0, width: 16, height: 10 }), { width: 16, height: 10 }, [{ x: 4, y: 4, width: 2, height: 2 }]);
    expect(pixel(image!, 3, 3)).toEqual([0, 0, 0, 255]);
    expect(pixel(image!, 6, 6)).toEqual([0, 0, 0, 255]);
  });

  it('withholds a capture whose window is not the size expected', () => {
    expect(windowImage(capture(30, 24, { x: 6, y: 3, width: 16, height: 10 }), { width: 40, height: 10 }, [])).toBeUndefined();
  });
});
