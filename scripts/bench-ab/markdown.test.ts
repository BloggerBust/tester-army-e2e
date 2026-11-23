import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Comparison } from './compare.ts';
import { renderMarkdown, type Header } from './markdown.ts';

const header: Header = {
  base: { ref: 'main', sha: '0123456789abcdef' },
  head: { sha: 'fedcba9876543210', dirty: false },
  suite: 'testbed',
  command: 'pnpm test',
  threshold: 0.05,
  floorMs: 20,
  stop: 'stopped after 1 pair',
  machine: 'linux x64',
  suiteDiffers: false,
};

function timing(median: number, q1: number, q3: number): Comparison {
  const spread = { median, q1, q3 };
  return {
    pairs: 1,
    changes: [],
    counters: [],
    timings: [{ name: 'suite', base: spread, head: spread, delta: { estimate: 0, low: 0, high: 0, level: 0.95, pairs: 1, verdict: 'same' }, belowFloor: true }],
    cases: [],
    casesCompared: 0,
  };
}

describe('renderMarkdown durations', () => {
  it('rounds before choosing ms or s, so 999.6 ms reads 1.00 s', () => {
    const markdown = renderMarkdown(header, timing(999.6, 999.4, 1_234));
    assert.match(markdown, /\| suite \| 1\.00 s \(999 ms-1\.23 s\) \|/u);
  });
});
