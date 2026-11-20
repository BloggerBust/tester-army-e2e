import { describe, expect, it } from 'vitest';
import { isRuntimeSkip, runtimeSkipCause } from '../../src/internal/skip.ts';

describe('runtimeSkipCause', () => {
  it('reports explicit for a runtime skip from a copy of e2e that names no cause', () => {
    const older: unknown = { [Symbol.for('e2e.runtimeSkip.v1')]: true, reason: 'not here' };
    if (!isRuntimeSkip(older)) throw new Error('expected the brand to be recognized');
    expect(runtimeSkipCause(older)).toBe('explicit');
  });

  it('keeps fixme, and reads any other value as explicit', () => {
    expect(runtimeSkipCause({ reason: 'r', cause: 'fixme' })).toBe('fixme');
    expect(runtimeSkipCause({ reason: 'r', cause: 'explicit' })).toBe('explicit');
    expect(runtimeSkipCause({ reason: 'r', cause: 'skipped' })).toBe('explicit');
  });
});
