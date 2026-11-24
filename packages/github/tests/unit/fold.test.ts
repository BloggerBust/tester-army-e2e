/** A rerun folded into the run before it: what the page shows for each kind of test. */

import { foldLastRun, renderMarkdownReport, type Report } from 'e2e';
import { describe, expect, it } from 'vitest';
import { attempt, report, result } from './fixtures.ts';

type ReportSerialGroup = Report['run']['serialGroups'][number];
type ReportSerialAttempt = ReportSerialGroup['attempts'][number];
type ReportError = Report['run']['errors'][number];

const failedAttempt = attempt({ status: 'failed', error: { code: 'ASSERTION_FAILED', message: 'no cart' } });
const leftOut = { cause: 'filtered' as const, reason: 'did not fail in the last run' };

const firstPass = report({
  status: 'failed',
  durationMs: 2_000,
  results: [
    result({ title: 'steady', status: 'passed', attempts: [attempt({ durationMs: 500 })] }),
    result({ title: 'recovers', status: 'failed', attempts: [failedAttempt, failedAttempt] }),
    result({ title: 'still broken', status: 'failed', attempts: [failedAttempt] }),
    result({ title: 'never wanted', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } }),
  ],
});

const rerun = report({
  status: 'failed',
  durationMs: 1_000,
  results: [
    result({ title: 'steady', status: 'skipped', selected: false, skip: leftOut }),
    result({ title: 'recovers', status: 'passed', attempts: [attempt({ durationMs: 900 })] }),
    result({ title: 'still broken', status: 'failed', attempts: [failedAttempt] }),
    result({ title: 'never wanted', status: 'skipped', selected: false, skip: leftOut }),
    result({ title: 'new since', status: 'passed', attempts: [attempt()] }),
  ],
});

const byTitle = (document: Report) => new Map(document.run.results.map((entry) => [`${entry.titlePath[0]}#${entry.repeat}`, entry]));

/** A serial group of one member, with one attempt in the given state. */
function serialGroup(id: string, memberTestId: string, status: 'passed' | 'failed'): ReportSerialGroup {
  const serialAttempt: ReportSerialAttempt = {
    id: `${id}:attempt`,
    index: 0,
    status,
    startedAt: '2026-07-24T12:00:00.000Z',
    durationMs: 700,
    artifacts: [],
    secondaryErrors: [],
    cleanup: 'complete',
    ...(status === 'failed' ? { error: { category: 'test', code: 'ASSERTION_FAILED', message: 'step one broke', retryable: false } } : {}),
    members: [
      {
        id: `${id}:member`,
        index: 0,
        testId: memberTestId,
        status,
        startedAt: '2026-07-24T12:00:00.000Z',
        durationMs: 700,
        steps: [],
        secondaryErrors: [],
        ...(status === 'failed' ? { error: { category: 'test', code: 'ASSERTION_FAILED', message: 'step one broke', retryable: false } } : {}),
      },
    ],
  };
  return {
    id,
    serialId: 'wizard',
    declarationIndex: 0,
    file: 'tests/example.e2e.ts',
    source: { file: 'tests/example.e2e.ts', line: 1, column: 1 },
    titlePath: ['wizard'],
    targetId: 'web',
    platform: 'web',
    agent: 'default',
    repeat: 0,
    memberTestIds: [memberTestId],
    status,
    attempts: [serialAttempt],
  };
}

describe('foldLastRun', () => {
  it('leaves the rerun as it is when the run before was an exploration', () => {
    const explored = report({ status: 'failed', results: [result({ title: 'Explore checkout', status: 'failed', attempts: [failedAttempt] })] });
    explored.run.explore = { goal: 'Explore checkout', budgets: { maxSteps: 8, timeoutMs: 600_000 }, ended: 'finished', steps: [], findings: [] };
    expect(foldLastRun(rerun, explored)).toBe(rerun);
  });

  it('carries the tests the rerun left out, marks a recovered test flaky with both runs\' attempts, and keeps a still-failing one failed', () => {
    const folded = foldLastRun(rerun, firstPass);
    const entries = byTitle(folded);
    expect(entries.get('steady#0')).toMatchObject({ status: 'passed', selected: true });
    expect(entries.get('steady#0')?.attempts).toHaveLength(1);
    expect(entries.get('recovers#0')).toMatchObject({ status: 'flaky', selected: true });
    expect(entries.get('recovers#0')?.attempts.map((entry) => entry.status)).toEqual(['failed', 'failed', 'passed']);
    expect(entries.get('still broken#0')).toMatchObject({ status: 'failed' });
    expect(entries.get('still broken#0')?.attempts).toHaveLength(2);
    // An explicit skip stays what the run before said it was; a test the run before never had is the rerun's.
    expect(entries.get('never wanted#0')).toMatchObject({ status: 'skipped', skip: { cause: 'explicit' } });
    expect(entries.get('new since#0')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.summary).toMatchObject({ discovered: 5, selected: 5, executed: 4, passed: 2, flaky: 1, failed: 1, interrupted: 0, skipped: 1 });
    expect(folded.run.status).toBe('failed');
    expect(folded.run.startedAt).toBe(firstPass.run.startedAt);
    expect(folded.run.finishedAt).toBe(rerun.run.finishedAt);
    expect(renderMarkdownReport(folded)).toContain('· 3.0s ·');
  });

  it('adds the wall time of an older saved run to the rerun duration', () => {
    const saved = report({ status: 'failed', finishedAt: '2026-07-24T12:00:07.000Z' });
    delete saved.run.durationMs;
    expect(renderMarkdownReport(foldLastRun(rerun, saved))).toContain('· 8.0s ·');
  });

  it('folds the repeats a plain rerun ran once into its one result, and carries the repeats of a test it left out', () => {
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'wobbly', status: 'passed', repeat: 0, attempts: [attempt()] }),
        result({ title: 'wobbly', status: 'failed', repeat: 1, attempts: [failedAttempt] }),
        result({ title: 'wobbly', status: 'failed', repeat: 2, attempts: [failedAttempt] }),
        result({ title: 'solid', status: 'passed', repeat: 0, attempts: [attempt()] }),
        result({ title: 'solid', status: 'passed', repeat: 1, attempts: [attempt()] }),
      ],
    });
    const once = report({
      results: [
        result({ title: 'wobbly', status: 'passed', attempts: [attempt()] }),
        result({ title: 'solid', status: 'skipped', selected: false, skip: leftOut }),
      ],
    });
    const folded = foldLastRun(once, before);
    const entries = byTitle(folded);
    expect(folded.run.results).toHaveLength(3);
    expect(entries.get('wobbly#0')).toMatchObject({ status: 'flaky' });
    expect(entries.get('wobbly#0')?.attempts.map((entry) => entry.status)).toEqual(['passed', 'failed', 'failed', 'passed']);
    expect(entries.get('wobbly#1')).toBeUndefined();
    expect(entries.get('solid#0')).toMatchObject({ status: 'passed', selected: true });
    expect(entries.get('solid#1')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.summary).toMatchObject({ discovered: 3, passed: 2, flaky: 1, failed: 0 });
    expect(folded.run.status).toBe('passed');
  });

  it('joins a rerun serial group\'s attempts to the run before\'s, so a member that passed after failing shows its failure', () => {
    const memberTestId = 'tests/example.e2e.ts::wizard::step%20one';
    const member = (status: 'passed' | 'failed', selected = true) =>
      result({ title: ['wizard', 'step one'], status, serialGroupId: 'g1', ...(selected ? {} : { selected: false, skip: leftOut }) });
    const before = report({ status: 'failed', results: [member('failed')], serialGroups: [serialGroup('g1', memberTestId, 'failed')] });
    const after = report({ results: [member('passed')], serialGroups: [serialGroup('g1', memberTestId, 'passed')] });
    const folded = foldLastRun(after, before);
    expect(folded.run.serialGroups).toHaveLength(1);
    expect(folded.run.serialGroups[0]?.attempts.map((entry) => [entry.index, entry.status])).toEqual([
      [0, 'failed'],
      [1, 'passed'],
    ]);
    expect(folded.run.results[0]).toMatchObject({ status: 'flaky' });
    const page = renderMarkdownReport(folded);
    expect(page).toContain('1 flaky test passed on a retry');
    expect(page).toContain('step one broke');
    // A group of a repeat the rerun never had stays beside the rerun's.
    const twoGroups = foldLastRun(after, { ...before, run: { ...before.run, serialGroups: [...before.run.serialGroups, serialGroup('g2', memberTestId, 'passed')] } });
    expect(twoGroups.run.serialGroups.map((group) => group.id)).toEqual(['g2', 'g1']);
  });

  it('turns the page red when a filter kept a failed test out of the rerun, since the page lists that failure', () => {
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'A', status: 'failed', attempts: [failedAttempt] }),
        result({ title: 'B', status: 'failed', attempts: [failedAttempt] }),
      ],
    });
    const onlyB = report({
      results: [
        result({ title: 'A', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
    });
    const folded = foldLastRun(onlyB, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'failed', selected: true });
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'flaky' });
    expect(folded.run.status).toBe('failed');
    expect(folded.run.exitCode).toBe(1);
    expect(renderMarkdownReport(folded)).toContain('### 🔴 e2e: 1 failed, 1 flaky');
  });

  it('counts an interrupted test apart from failures: one that passes on the rerun is not flaky, and a carried one keeps the page from reading green', () => {
    const interruptedAttempt = attempt({ status: 'interrupted', error: { category: 'interrupted', code: 'INTERRUPTED', message: 'run interrupted in phase test' } });
    const before = report({
      status: 'interrupted',
      results: [
        result({ title: 'A', status: 'interrupted', attempts: [interruptedAttempt] }),
        result({ title: 'B', status: 'interrupted', attempts: [interruptedAttempt] }),
      ],
    });
    const onlyA = report({
      results: [
        result({ title: 'A', status: 'passed', attempts: [attempt()] }),
        result({ title: 'B', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
      ],
    });
    const folded = foldLastRun(onlyA, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'passed' });
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'interrupted', selected: true });
    expect(folded.run.summary).toMatchObject({ selected: 2, passed: 1, failed: 0, interrupted: 1, flaky: 0, skipped: 0 });
    expect(folded.run.status).toBe('passed');
    expect(renderMarkdownReport(folded)).toContain('### ⏹️ e2e: 1 interrupted, 1 passed');

    // The runner carries B, still owed; a carried interrupted test reached no verdict, so it does not red the page.
    const carryingB = report({ results: onlyA.run.results, carried: { results: [before.run.results[1]!], serialGroups: [], errors: [] } });
    const foldedCarried = foldLastRun(carryingB, before);
    expect(byTitle(foldedCarried).get('B#0')).toMatchObject({ status: 'interrupted', selected: true });
    expect(foldedCarried.run).toMatchObject({ status: 'passed', exitCode: 0 });
    expect(renderMarkdownReport(foldedCarried)).toContain('### ⏹️ e2e: 1 interrupted, 1 passed');
  });

  it('keeps the first pass\'s failure when the rerun of that test is interrupted', () => {
    const interruptedAttempt = attempt({ status: 'interrupted', error: { category: 'interrupted', code: 'INTERRUPTED', message: 'run interrupted in phase test' } });
    const before = report({ status: 'failed', results: [result({ title: 'A', status: 'failed', attempts: [failedAttempt] })] });
    const cut = report({ status: 'interrupted', results: [result({ title: 'A', status: 'interrupted', attempts: [interruptedAttempt] })] });
    const folded = foldLastRun(cut, before);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'failed' });
    expect(folded.run.summary).toMatchObject({ failed: 1, interrupted: 0 });
    expect(renderMarkdownReport(folded)).toContain('### 🔴 e2e: 1 failed');
  });

  it('keeps the page red while the rerun carries a hook failure or a failed test it did not run again, with their evidence', () => {
    const scope = { file: 'tests/a.e2e.ts', targetId: 'web', titlePath: [] };
    const hook: ReportError = { category: 'test', code: 'HOOK_FAILED', message: 'afterAll failed: teardown broke', retryable: false, phase: 'afterAll', scopeId: 'file', scope };
    const evidence = attempt({ artifacts: ['screenshot'] });
    const inHookScope = result({ title: 'A', file: 'tests/a.e2e.ts', status: 'passed', attempts: [evidence] });
    const before = report({ status: 'failed', results: [inHookScope, result({ title: 'B', status: 'failed', attempts: [failedAttempt] })], errors: [hook] });
    const onlyB = report({
      results: [
        result({ title: 'A', file: 'tests/a.e2e.ts', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
      carried: { results: [inHookScope], serialGroups: [], errors: [hook] },
    });
    const folded = foldLastRun(onlyB, before);
    expect(byTitle(folded).get('A#0')).toEqual(inHookScope);
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'flaky' });
    expect(folded.run.errors).toEqual([hook]);
    expect(folded.run.status).toBe('failed');
    expect(folded.run.exitCode).toBe(1);
    const page = renderMarkdownReport(folded);
    expect(page).toContain('### 🔴 e2e: 1 flaky, 1 passed');
    expect(page).toContain('HOOK_FAILED');

    // A carried test that failed reds the page on its own.
    const carriedFailure = result({ title: 'C', status: 'failed', attempts: [failedAttempt] });
    const withFailure = report({
      results: [result({ title: 'C', status: 'skipped', selected: false, skip: leftOut }), result({ title: 'B', status: 'passed', attempts: [attempt()] })],
      carried: { results: [carriedFailure], serialGroups: [], errors: [] },
    });
    expect(foldLastRun(withFailure, report({ results: [result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })] })).run.status).toBe('failed');

    // So does one the failure limit stopped before it ever ran.
    const neverRan = result({ title: 'D', status: 'skipped', skip: { cause: 'failure-limit', reason: 'run stopped after 1 failure (--max-failures 1)' } });
    const withLimit = report({
      results: [result({ title: 'D', status: 'skipped', selected: false, skip: leftOut }), result({ title: 'B', status: 'passed', attempts: [attempt()] })],
      carried: { results: [neverRan], serialGroups: [], errors: [] },
    });
    expect(foldLastRun(withLimit, report({ results: [result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })] })).run).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('reads a test the run before carried by the row it carried, so a rerun that runs it at last folds in its first failure', () => {
    const firstFailure = result({ title: 'A', status: 'failed', attempts: [failedAttempt] });
    const narrowed = report({
      results: [
        result({ title: 'A', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }),
        result({ title: 'B', status: 'passed', attempts: [attempt()] }),
      ],
      carried: { results: [firstFailure], serialGroups: [], errors: [] },
    });
    const atLast = report({
      results: [result({ title: 'A', status: 'passed', attempts: [attempt()] }), result({ title: 'B', status: 'skipped', selected: false, skip: leftOut })],
    });
    const folded = foldLastRun(atLast, narrowed);
    expect(byTitle(folded).get('A#0')).toMatchObject({ status: 'flaky' });
    expect(byTitle(folded).get('A#0')?.attempts.map((entry) => entry.status)).toEqual(['failed', 'passed']);
    expect(byTitle(folded).get('B#0')).toMatchObject({ status: 'passed', selected: true });
    expect(folded.run.status).toBe('passed');
  });

  it("shows a carried serial member's group, where its attempts live", () => {
    const memberTestId = 'tests/example.e2e.ts::wizard::step%20one';
    const member = result({ title: ['wizard', 'step one'], status: 'failed', serialGroupId: 'g1' });
    const group = serialGroup('g1', memberTestId, 'failed');
    const narrowed = report({
      results: [{ ...member, status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } }],
      carried: { results: [member], serialGroups: [group], errors: [] },
    });
    const folded = foldLastRun(narrowed, report({ results: [{ ...member, status: 'skipped', selected: false, skip: leftOut }] }));
    expect(folded.run.serialGroups).toEqual([group]);
    expect(folded.run.status).toBe('failed');
    expect(renderMarkdownReport(folded)).toContain('step one broke');
  });

  it('keeps the filters and the change of the run before beside the tests its filters left out, since a --last-failed rerun runs no filter', () => {
    const base = '0123456789abcdef0123456789abcdef01234567';
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'alpha', status: 'failed', attempts: [failedAttempt] }),
        result({ title: 'beta', status: 'passed', attempts: [attempt()] }),
        result({ title: 'gamma', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'Jev: 5% likely affected', filter: 'jev' } }),
      ],
      filters: [{ name: 'jev', candidates: 3, excluded: 1 }],
      changes: { base, files: 4 },
    });
    const lastFailed = report({
      results: [
        result({ title: 'alpha', status: 'passed', attempts: [attempt()] }),
        result({ title: 'beta', status: 'skipped', selected: false, skip: leftOut }),
        result({ title: 'gamma', status: 'skipped', selected: false, skip: leftOut }),
      ],
      changes: { skipped: '--last-failed' },
    });
    const folded = foldLastRun(lastFailed, before);
    expect(folded.run.filters).toEqual(before.run.filters);
    expect(folded.run.changes).toEqual(before.run.changes);
    expect(byTitle(folded).get('gamma#0')).toMatchObject({ selected: false, skip: { filter: 'jev' } });
    const page = renderMarkdownReport(folded);
    expect(page).toContain(', 1 left out by filters\n');
    expect(page).toContain('**Filter** `jev` kept 2 of 3 tests, left out 1\n');

    // A first pass that ran no filter folds to no run.filters and no run.changes, not even the rerun's `--last-failed` record.
    const unfiltered = foldLastRun(lastFailed, report({ status: 'failed', results: before.run.results.slice(0, 2) }));
    expect(unfiltered.run.filters).toBeUndefined();
    expect(unfiltered.run.changes).toBeUndefined();
  });

  it('counts only the tests still left out on the page when the rerun ran one the run before\'s filter left out', () => {
    const before = report({
      status: 'failed',
      results: [
        result({ title: 'sign in', status: 'failed', attempts: [failedAttempt] }),
        result({ title: 'member b', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'unaffected', filter: 'pages' } }),
        result({ title: 'guest page', status: 'passed', attempts: [attempt()] }),
      ],
      filters: [{ name: 'pages', candidates: 2, excluded: 1 }],
      changes: { base: '0123456789abcdef0123456789abcdef01234567', files: 2 },
    });
    const lastFailed = report({
      results: [
        result({ title: 'sign in', status: 'passed', attempts: [attempt()] }),
        result({ title: 'member b', status: 'passed', attempts: [attempt()] }),
        result({ title: 'guest page', status: 'skipped', selected: false, skip: leftOut }),
      ],
      changes: { skipped: '--last-failed' },
    });
    const folded = foldLastRun(lastFailed, before);
    expect(byTitle(folded).get('member b#0')).toMatchObject({ selected: true, status: 'passed' });
    const page = renderMarkdownReport(folded);
    expect(page).toContain('**Filter** `pages` kept all 2 tests\n');
    expect(page).not.toContain('left out by filters');
  });

  it.each(['explicit', 'fixme'] as const)('counts a serial member executed when its body ran in any group attempt, one that skipped itself (cause %s) included', (cause) => {
    const titles = ['one', 'two', 'three'];
    const memberIds = titles.map((title) => `tests/example.e2e.ts::wizard::${title}`);
    const blocked = { cause: 'serial-predecessor-failed' as const, reason: 'member 0 failed in this group attempt' };
    const run = (statuses: readonly ('failed' | 'skipped' | 'self-skipped')[]) => {
      const group = serialGroup('g1', memberIds[0]!, 'failed');
      const members = statuses.map((status, index) => ({
        ...group.attempts[0]!.members[0]!,
        id: `g1:member:${index}`,
        index,
        testId: memberIds[index]!,
        status: status === 'failed' ? ('failed' as const) : ('skipped' as const),
        ...(status === 'failed' ? {} : { error: undefined, skip: status === 'self-skipped' ? { cause, reason: 'not here' } : blocked }),
      }));
      return report({
        status: 'failed',
        results: statuses.map((status, index) =>
          result({ title: ['wizard', titles[index]!], status: status === 'failed' ? 'failed' : 'skipped', serialGroupId: 'g1', ...(status === 'failed' ? {} : { skip: members[index]!.skip }) }),
        ),
        serialGroups: [{ ...group, memberTestIds: memberIds, attempts: [{ ...group.attempts[0]!, members }] }],
      });
    };
    const folded = foldLastRun(run(['self-skipped', 'failed', 'skipped']), run(['failed', 'skipped', 'skipped']));
    // One ran in both runs and skipped itself in the rerun, two ran in the rerun, three never started.
    expect(folded.run.summary).toMatchObject({ selected: 3, executed: 2, failed: 1, skipped: 2 });
    // Two ran only in the rerun, where it skipped itself.
    const selfSkippedOnly = foldLastRun(run(['failed', 'self-skipped', 'skipped']), run(['failed', 'skipped', 'skipped']));
    expect(selfSkippedOnly.run.summary).toMatchObject({ selected: 3, executed: 2, failed: 1, skipped: 2 });
  });

  it('leaves the rerun alone when the run before is another project\'s', () => {
    const other = report({ projectId: 'dev.example.other', status: 'failed', results: firstPass.run.results });
    expect(foldLastRun(rerun, other)).toBe(rerun);
  });

  it('keeps a test flaky when it passes again after a run that was already flaky', () => {
    const before = report({ results: [result({ title: 'wobbly', status: 'flaky', attempts: [failedAttempt, attempt()] })] });
    const again = report({ results: [result({ title: 'wobbly', status: 'passed', attempts: [attempt()] })] });
    const folded = byTitle(foldLastRun(again, before)).get('wobbly#0')!;
    expect(folded.status).toBe('flaky');
    expect(folded.attempts.map((entry) => [entry.status, entry.index])).toEqual([['failed', 0], ['passed', 1], ['passed', 2]]);
  });

  it('keeps every attempt of a test the run before holds a result for, over the last result the rerun carries for it', () => {
    // A fold of two runs that both failed `owed`, then a rerun another filter kept it out of.
    const history = report({ status: 'failed', results: [result({ title: 'owed', status: 'failed', attempts: [failedAttempt, failedAttempt] })] });
    const carriedRow = result({ title: 'owed', status: 'failed', attempts: [failedAttempt] });
    const leftOutRerun = report({
      status: 'failed',
      results: [result({ title: 'owed', status: 'skipped', selected: false, skip: { cause: 'filtered', reason: 'title does not match --grep' } })],
      carried: { results: [carriedRow], serialGroups: [], errors: [] },
    });
    const folded = foldLastRun(leftOutRerun, history);
    expect(byTitle(folded).get('owed#0')!.attempts).toHaveLength(2);
    // And the next fold reads that row over the carried one too.
    const passes = report({ results: [result({ title: 'owed', status: 'passed', attempts: [attempt()] })] });
    expect(byTitle(foldLastRun(passes, folded)).get('owed#0')).toMatchObject({ status: 'flaky', attempts: [{}, {}, {}] });
  });

  it("folds the group of a serial member's further repeat into the group of the result a plain rerun ran", () => {
    const member = (repeat: number, status: 'passed' | 'failed', group: string) =>
      result({ title: ['wizard', 'step one'], status, serialGroupId: group, repeat });
    const firstMember = member(0, 'passed', 'g0');
    const before = report({
      status: 'failed',
      results: [firstMember, member(1, 'failed', 'g1')],
      serialGroups: [serialGroup('g0', firstMember.testId, 'passed'), { ...serialGroup('g1', firstMember.testId, 'failed'), repeat: 1 }],
    });
    const again = report({ results: [member(0, 'passed', 'g0')], serialGroups: [serialGroup('g0', firstMember.testId, 'passed')] });
    const folded = foldLastRun(again, before);
    expect(folded.run.serialGroups.map((group) => [group.id, group.attempts.map((entry) => entry.status)])).toEqual([['g0', ['passed', 'failed', 'passed']]]);
    expect(folded.run.results.map((entry) => [entry.repeat, entry.status, entry.serialGroupId])).toEqual([[0, 'flaky', 'g0']]);
  });

  it('takes the shard from the run that chose the tests, and none when it was not sharded', () => {
    // The fixture report is a shard; these runs say for themselves whether they were.
    const unsharded = (document: Report): Report => {
      const { shard: _shard, ...run } = document.run;
      return { ...document, run };
    };
    const whole = unsharded(report({ status: 'failed', results: [result({ title: 'owed', status: 'failed', attempts: [failedAttempt] })] }));
    const sharded = { ...rerun, run: { ...rerun.run, shard: { index: 1, total: 2 } } };
    expect(foldLastRun(sharded, whole).run.shard).toBeUndefined();
    const firstShard = { ...whole, run: { ...whole.run, shard: { index: 3, total: 4 } } };
    expect(foldLastRun(unsharded(rerun), firstShard).run.shard).toEqual({ index: 3, total: 4 });
    expect(foldLastRun(sharded, firstShard).run.shard).toEqual({ index: 3, total: 4 });
  });

  it('keeps the earlier verdict and serial group of a test the rerun never reached, so a later pass is flaky', () => {
    const member = (status: 'failed' | 'skipped' | 'passed', group?: string, skip?: Report['run']['results'][number]['skip']) =>
      result({ title: ['wizard', 'step two'], status, ...(group === undefined ? {} : { serialGroupId: group }), ...(skip === undefined ? {} : { skip }) });
    const first = member('failed', 'g1');
    const failedRun = report({ status: 'failed', results: [first], serialGroups: [serialGroup('g1', first.testId, 'failed')] });
    // A failure limit stopped the rerun before the group started: the member was never reached and names no group.
    const stopped = report({ status: 'failed', results: [member('skipped', undefined, { cause: 'failure-limit', reason: 'the run stopped at --max-failures 1' })] });
    const unreached = foldLastRun(stopped, failedRun);
    expect(unreached.run.results.map((entry) => [entry.status, entry.serialGroupId])).toEqual([['failed', 'g1']]);
    expect(unreached.run.summary).toMatchObject({ executed: 1, failed: 1 });
    const passes = report({ results: [member('passed', 'g1')], serialGroups: [serialGroup('g1', first.testId, 'passed')] });
    expect(foldLastRun(passes, unreached).run.results.map((entry) => entry.status)).toEqual(['flaky']);
  });

  it('keeps the flaky verdict when a standalone test becomes serial and its earlier attempt cannot be folded', () => {
    const standalone = report({ status: 'failed', results: [result({ title: ['wizard', 'step one'], status: 'failed', attempts: [failedAttempt] })] });
    const nowSerial = result({ title: ['wizard', 'step one'], status: 'passed', serialGroupId: 'g1' });
    const again = report({ results: [nowSerial], serialGroups: [serialGroup('g1', nowSerial.testId, 'passed')] });
    const folded = foldLastRun(again, standalone);
    expect(folded.run.results.map((entry) => [entry.status, entry.attempts.length, entry.serialGroupId])).toEqual([['flaky', 0, 'g1']]);
    expect(folded.run.serialGroups[0]?.attempts).toHaveLength(1);
  });

  it('counts a row an older report wrote without selected as selected, the way the page reads it', () => {
    const older = report({ status: 'failed', results: [result({ title: 'steady', status: 'passed', attempts: [attempt()] }), result({ title: 'broken', status: 'failed', attempts: [failedAttempt] })] });
    for (const row of older.run.results as readonly { selected?: boolean }[]) delete row.selected;
    const again = report({
      results: [
        result({ title: 'steady', status: 'skipped', selected: false, skip: leftOut }),
        result({ title: 'broken', status: 'passed', attempts: [attempt()] }),
      ],
    });
    expect(foldLastRun(again, older).run.summary).toMatchObject({ selected: 2, passed: 1, flaky: 1 });
  });

  it('adds up the runs\' usage, and keeps the larger of each per-step maximum (guard)', () => {
    const usage = (n: number, extra: object = {}) => ({
      discoveredResults: 9, maxAgentContextBytes: n, maxLedgerBytes: n, maxObservationBytes: n, artifactBytes: n, downloads: n, events: n, modelTokens: n, maxModelCallsInStep: n, maxActionStepsInStep: n, ...extra,
    });
    const before = { ...firstPass, run: { ...firstPass.run, usage: usage(5, { modelCachedTokens: 2, estimatedCostUsd: 0.25 }) } };
    const after = { ...rerun, run: { ...rerun.run, usage: usage(3) } };
    expect(foldLastRun(after, before).run.usage).toEqual({
      discoveredResults: 5, maxAgentContextBytes: 5, maxLedgerBytes: 5, maxObservationBytes: 5, artifactBytes: 8, downloads: 8, events: 8, modelTokens: 8,
      maxModelCallsInStep: 5, maxActionStepsInStep: 5, modelCachedTokens: 2, estimatedCostUsd: 0.25,
    });
  });

  it('keeps no skip on a row whose kept verdict is not skipped, and keeps an earlier pass of a test the rerun never reached', () => {
    const limit = { cause: 'failure-limit' as const, reason: 'the run stopped at --max-failures 1' };
    const before = report({
      status: 'failed',
      results: [result({ title: 'broken', status: 'failed', attempts: [failedAttempt] }), result({ title: 'steady', status: 'passed', attempts: [attempt()] })],
    });
    const stopped = report({
      status: 'failed',
      results: [result({ title: 'broken', status: 'skipped', skip: limit }), result({ title: 'steady', status: 'skipped', skip: limit })],
    });
    const folded = foldLastRun(stopped, before);
    expect(folded.run.results.map((entry) => [entry.titlePath[0], entry.status, entry.skip])).toEqual([
      ['broken', 'failed', undefined],
      ['steady', 'passed', undefined],
    ]);
    // A row the rerun did reach and skip keeps its skip.
    const parked = report({ results: [result({ title: 'steady', status: 'skipped', skip: { cause: 'explicit', reason: 'later' } })] });
    expect(foldLastRun(parked, before).run.results.find((entry) => entry.titlePath[0] === 'steady')?.skip).toEqual({ cause: 'explicit', reason: 'later' });
  });

  it('keeps a row the first run gave another shard as it was, whatever the rerun ran', () => {
    const otherShards = { cause: 'filtered' as const, reason: 'outside the shard', otherShard: true as const };
    const shard = report({
      status: 'failed',
      results: [result({ title: 'theirs', status: 'skipped', selected: false, skip: otherShards }), result({ title: 'ours', status: 'failed', attempts: [failedAttempt] })],
    });
    const sharded = { ...shard, run: { ...shard.run, shard: { index: 2, total: 2 } } };
    // A failed setup widened the rerun to every consumer, the other shard's too.
    const widened = report({ results: [result({ title: 'theirs', status: 'passed', attempts: [attempt()] }), result({ title: 'ours', status: 'passed', attempts: [attempt()] })] });
    const folded = foldLastRun(widened, sharded);
    expect(folded.run.results.map((entry) => [entry.titlePath[0], entry.selected, entry.status, entry.skip?.otherShard])).toEqual([
      ['theirs', false, 'skipped', true],
      ['ours', true, 'flaky', undefined],
    ]);
    expect(folded.run.summary).toMatchObject({ selected: 1, flaky: 1, passed: 0 });
  });

  it('explains a foreign serial failure after a later rerun filters it out', () => {
    const foreign = result({ title: 'foreign', status: 'failed', serialGroupId: 'outside' });
    const group = serialGroup('outside', foreign.testId, 'failed');
    const initial = report({
      results: [result({ title: 'foreign', status: 'skipped', selected: false, skip: { ...leftOut, otherShard: true } })],
    });
    const widened = report({ status: 'failed', results: [foreign], serialGroups: [group] });
    const firstFold = foldLastRun(widened, initial);
    expect(firstFold.run.errors.map((error) => error.message)).toEqual([expect.stringContaining('step one broke')]);
    expect(firstFold.run.serialGroups).toEqual([]);

    const filtered = report({ results: [result({ title: 'foreign', status: 'skipped', selected: false, skip: leftOut })] });
    const folded = foldLastRun({ ...filtered, run: { ...filtered.run, carried: { results: [foreign], serialGroups: [group], errors: [] } } }, firstFold);
    expect(folded.run).toMatchObject({ status: 'failed', results: [{ selected: false, skip: { otherShard: true } }], serialGroups: [] });
    expect(folded.run.errors.map((error) => error.message)).toEqual([expect.stringContaining('step one broke')]);

    const again = foldLastRun(widened, folded);
    expect(again.run.results).toEqual(folded.run.results);
    expect(again.run.serialGroups).toEqual([]);
  });
});
