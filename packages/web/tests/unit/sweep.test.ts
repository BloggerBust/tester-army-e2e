/** `releaseEach`: every lease released at once, sorted into released, already gone, and failed. */

import { describe, expect, it } from 'vitest';
import { releaseEach } from '../../src/sweep.ts';

describe('releaseEach', () => {
  it('releases every lease even when one fails, and leaves out the ones the service no longer had', async () => {
    const asked: string[] = [];
    const outcome = await releaseEach(['a', 'b', 'c', 'd'], async (id) => {
      asked.push(id);
      if (id === 'b') throw new Error('internal');
      if (id === 'c') throw 'not an error';
      return id !== 'd';
    });
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
    expect(outcome).toEqual({ released: ['a'], failed: [{ id: 'b', reason: 'internal' }, { id: 'c', reason: 'not an error' }] });
  });

  it('counts a release that throws before it awaits as a failure, not an escape', async () => {
    const outcome = await releaseEach(['a', 'b'], (id) => {
      if (id === 'a') throw new Error('sync');
      return Promise.resolve(true);
    });
    expect(outcome).toEqual({ released: ['b'], failed: [{ id: 'a', reason: 'sync' }] });
  });

  it('resolves to empty lists for no leases', async () => {
    await expect(releaseEach([], async () => true)).resolves.toEqual({ released: [], failed: [] });
  });
});
