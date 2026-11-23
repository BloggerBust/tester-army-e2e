import { describe, expect, it } from 'vitest';
import { formatSize } from '../../src/format.ts';

describe('formatSize', () => {
  it('rounds up to whole KB before choosing KB or MB, so just under 1 MB reads 1.0 MB', () => {
    expect(formatSize(1)).toBe('1 KB');
    expect(formatSize(1_047_552)).toBe('1023 KB');
    expect(formatSize(1_047_553)).toBe('1.0 MB');
    expect(formatSize(1_048_576)).toBe('1.0 MB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
