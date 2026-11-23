import { describe, expect, it } from 'vitest';
import { formatMs } from '../../src/internal/debug.ts';

describe('formatMs', () => {
  it('rounds before choosing ms or s, so 9999.6ms reads 10.0s', () => {
    expect(formatMs(250.4)).toBe('250ms');
    expect(formatMs(9_999.4)).toBe('9999ms');
    expect(formatMs(9_999.6)).toBe('10.0s');
    expect(formatMs(12_340)).toBe('12.3s');
  });
});
