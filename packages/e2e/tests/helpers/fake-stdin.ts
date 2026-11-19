import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

/** A stdin stand-in: keys arrive as writes, raw mode is recorded. */
export function fakeStdin(): NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> } {
  const setRawMode = vi.fn();
  return Object.assign(new PassThrough(), { setRawMode }) as unknown as NodeJS.ReadStream & { setRawMode: typeof setRawMode };
}
