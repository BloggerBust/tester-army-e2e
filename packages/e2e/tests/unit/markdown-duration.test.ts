import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../src/report/markdown-text.ts';

describe('formatDuration', () => {
  it('rounds before choosing the unit, so the value carries over', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(999.4)).toBe('999ms');
    expect(formatDuration(999.6)).toBe('1.0s');
    expect(formatDuration(12_340)).toBe('12.3s');
    expect(formatDuration(59_949)).toBe('59.9s');
    expect(formatDuration(59_960)).toBe('1m 0s');
    expect(formatDuration(119_400)).toBe('1m 59s');
    expect(formatDuration(119_600)).toBe('2m 0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
  });
});
