import { afterEach, describe, expect, it, vi } from 'vitest';
import { line } from '../../src/report/line.ts';
import { cursorRow } from '../../src/report/progress.ts';

describe('line reporter cursor grant', () => {
  afterEach(() => vi.restoreAllMocks());

  it('starts without the cursor row, and a view takes the grant with it', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = line();
    const cursor = cursorRow.get(reporter);
    expect(cursor).toEqual({ exclusive: false });
    cursor!.exclusive = true;
    reporter.onSummary?.([]);
    expect(cursor!.exclusive).toBe(false);
  });
});
