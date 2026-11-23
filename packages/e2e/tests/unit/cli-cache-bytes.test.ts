import { describe, expect, it } from 'vitest';
import { formatBytes } from '../../src/cli/format-bytes.ts';

describe('formatBytes', () => {
  it('rounds before choosing KiB or MiB, so just under 1 MiB reads 1.0 MiB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1_280)).toBe('1.3 KiB');
    expect(formatBytes(1_536)).toBe('1.5 KiB');
    expect(formatBytes(1_048_473)).toBe('1023.9 KiB');
    expect(formatBytes(1_048_575)).toBe('1.0 MiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
  });
});
