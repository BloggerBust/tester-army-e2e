import type { Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { buildModel, formatDuration, formatTokens, onTarget, selectedTarget, statusTabs } from '../../app/data.ts';
import fixture from '../../../e2e/schema/fixtures/report-v1.valid.json' with { type: 'json' };

// The page's own tsconfig checks this file: the model it tests reads the DOM.
const REPORT = fixture as unknown as Report;

describe('serial members', () => {
  it('show their own error, never the group\'s once they passed, and the group\'s when they have none', () => {
    const [group] = REPORT.run.serialGroups;
    const [attempt] = group!.attempts;
    const [member] = attempt!.members;
    const result = REPORT.run.results.find((candidate) => candidate.serialGroupId === group!.id);
    const failure = REPORT.run.results.flatMap((each) => each.attempts).find((each) => each.error !== undefined)!.error!;
    const members = [
      { ...member!, testId: 'failed', status: 'failed', error: failure },
      { ...member!, testId: 'passed', status: 'passed' },
      { ...member!, testId: 'skipped', status: 'skipped' },
      { ...member!, testId: 'failed in afterAll', status: 'failed' },
    ] as const;
    const model = buildModel({
      report: {
        ...REPORT,
        run: {
          ...REPORT.run,
          results: members.map(({ testId }) => ({ ...result!, testId, selected: true })),
          serialGroups: [{ ...group!, attempts: [{ ...attempt!, error: failure, members }] }],
        },
      },
      media: { mode: 'none' },
      resultsDir: '.e2e/results',
      traces: {},
      sources: {},
    });
    expect(model.results.map((each) => [each.testId, model.attempts(each)[0]?.error?.message])).toEqual([
      ['failed', failure.message],
      ['passed', undefined],
      ['skipped', failure.message],
      ['failed in afterAll', failure.message],
    ]);
  });
});

describe('formatDuration', () => {
  it('rounds before choosing the unit, so the value carries over', () => {
    expect(formatDuration(999.6)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_949)).toBe('59.9s');
    expect(formatDuration(59_960)).toBe('1m 0s');
    expect(formatDuration(119_600)).toBe('2m 0s');
  });
});

describe('formatTokens', () => {
  it('rounds before choosing the unit, so the value carries over', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(999_949)).toBe('999.9k');
    expect(formatTokens(999_950)).toBe('1.0M');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
});

describe('onTarget', () => {
  const [first, second] = REPORT.run.results;
  const split = [
    { ...first!, targetId: 'web' },
    { ...second!, targetId: 'mobile' },
    { ...first!, targetId: 'web' },
  ];

  it('answers every result when no target is named, as the same list', () => {
    expect(onTarget(split, undefined)).toBe(split);
  });

  it('keeps only the results that ran on the named target', () => {
    expect(onTarget(split, 'mobile').map((result) => result.targetId)).toEqual(['mobile']);
    expect(onTarget(split, 'web')).toHaveLength(2);
  });

  it('answers none for a target the run did not select', () => {
    expect(onTarget(split, 'tablet')).toEqual([]);
  });
});

describe('selectedTarget', () => {
  const two = new Set(['web', 'mobile']);
  const one = new Set(['web']);

  it('answers the target a multi-target run carries', () => {
    expect(selectedTarget(two, 'mobile')).toBe('mobile');
  });

  it('answers none for a target the run did not carry, or for no value at all', () => {
    expect(selectedTarget(two, 'tablet')).toBeUndefined();
    expect(selectedTarget(two, null)).toBeUndefined();
    expect(selectedTarget(two, undefined)).toBeUndefined();
  });

  it('answers none on a single-target run, which renders no tab that could clear the choice', () => {
    expect(selectedTarget(one, 'web')).toBeUndefined();
  });
});

describe('statusTabs', () => {
  const counts = { all: 3, failed: 0, flaky: 0, passed: 2, skipped: 1, interrupted: 0 };

  it('keeps every status with results, in tab order, with all first', () => {
    expect(statusTabs(counts, 'all')).toEqual(['all', 'passed', 'skipped']);
  });

  it('keeps the active tab even at 0, so a filter never strands itself', () => {
    expect(statusTabs(counts, 'failed')).toEqual(['all', 'failed', 'passed', 'skipped']);
  });
});
