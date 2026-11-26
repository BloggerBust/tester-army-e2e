import type { Report } from 'e2e';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildModel, formatDuration, formatTokens, onTarget, selectedTarget, statusTabs, stepDepths, timedVideos, videoName, videoPosition, type Artifact, type Step } from '../../app/data.ts';
import { ListView } from '../../app/list.tsx';
import fixture from '../../../e2e/schema/fixtures/report-v1.valid.json' with { type: 'json' };

// The page's own tsconfig checks this file: the model it tests reads the DOM.
const REPORT = fixture as unknown as Report;

describe('the run summary', () => {
  it('shows the recorded run duration. For older reports the duration comes from the timestamps', () => {
    const report = { ...REPORT, run: { ...REPORT.run, durationMs: 765 } };
    const model = buildModel({ report, media: { mode: 'none' }, resultsDir: '.e2e/results', traces: {}, sources: {} });
    const page = createElement(ListView, { model, status: 'all', search: '', target: undefined });

    expect(renderToStaticMarkup(page)).toContain('>765ms<');
    delete model.run.durationMs;
    expect(renderToStaticMarkup(page)).toContain('>1.0s<');
  });
});

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

describe('stepDepths', () => {
  it('counts the test.step calls around each step', () => {
    const step = (index: number, parent?: number): Step => ({ index, ...(parent === undefined ? {} : { parent }) }) as Step;
    const steps = [step(0), step(1, 0), step(2, 1), step(3, 0), step(4)];
    expect(steps.map(stepDepths(steps))).toEqual([0, 1, 2, 1, 0]);
  });
});

describe('videos of a test that drove a second session', () => {
  const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  const video = (id: string, startedAt: string, actor?: string): Artifact => ({
    id, kind: 'video', mediaType: 'video/webm', path: `t/attempt-1/video/${id}.webm`, startedAt,
    redaction: 'incomplete', producer: { kind: 'attempt' }, ...(actor === undefined ? {} : { actor }),
  });
  const step = (startedAt: string, actor?: string): Step => ({ startedAt, ...(actor === undefined ? {} : { actor }) }) as Step;
  // The test's own video in two parts, and the session's video recorded while the first part ran.
  const videos = timedVideos([video('video', at(0)), video('launch-1', at(2), 'launch-1'), video('video-part2', at(10))], { mode: 'link', base: 'results' });

  it('ends each recording where the next of its own session begins', () => {
    expect(videos.map((each) => [each.artifact.id, each.endsAt])).toEqual([
      ['video', Date.parse(at(10))],
      ['launch-1', Infinity],
      ['video-part2', Infinity],
    ]);
  });

  it('places a step in the recording of the session it ran on', () => {
    expect(videoPosition(step(at(5)), videos)).toEqual({ video: 0, seconds: 5 });
    expect(videoPosition(step(at(5), 'launch-1'), videos)).toEqual({ video: 1, seconds: 3 });
    expect(videoPosition(step(at(12)), videos)).toEqual({ video: 2, seconds: 2 });
    // Before its session's recording began, at that recording's start; a session with no recording, nowhere.
    expect(videoPosition(step(at(1), 'launch-1'), videos)).toEqual({ video: 1, seconds: 0 });
    expect(videoPosition(step(at(5), 'launch-2'), videos)).toBeUndefined();
  });

  it('names each recording by its session, and the test\'s own parts by number', () => {
    expect(videos.map((each) => videoName(each, videos))).toEqual(['test part 1', 'launch-1', 'test part 2']);
    const alone = timedVideos([video('video', at(0)), video('video-part2', at(10))], { mode: 'link', base: 'results' });
    expect(alone.map((each) => videoName(each, alone))).toEqual(['part 1', 'part 2']);
  });
});
