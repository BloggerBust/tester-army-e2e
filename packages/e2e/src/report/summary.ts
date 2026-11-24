/**
 * The one tally of a report: `run.summary` counted from its rows. The
 * runner counts its report with it, and so does a fold of a `--last-failed`
 * rerun into the runs before it, so the two can never disagree.
 */

import { memberRan } from '@e2e-dev/core/lib/run/records';
import type { ReportResult, ReportSerialGroup, ReportSummary } from './build.ts';

/**
 * Counts `results`: the status counts are over the selected ones (every row
 * not marked `selected: false`) and add up
 * to `selected`; a result executed when it made an attempt, or, for a serial
 * member, when one of its group's attempts ran its body (a body that skipped
 * itself included).
 */
export function summarizeResults(results: readonly ReportResult[], serialGroups: readonly ReportSerialGroup[]): ReportSummary {
  const ranMembers = new Set(
    serialGroups.flatMap((group) =>
      group.attempts.flatMap((attempt) => attempt.members.filter(memberRan).map((member) => `${group.id}\u0000${member.testId}`)),
    ),
  );
  const summary: ReportSummary = { discovered: results.length, selected: 0, executed: 0, passed: 0, failed: 0, interrupted: 0, flaky: 0, skipped: 0 };
  for (const result of results) {
    if (result.attempts.length > 0 || (result.serialGroupId !== undefined && ranMembers.has(`${result.serialGroupId}\u0000${result.testId}`))) {
      summary.executed += 1;
    }
    // A row an older report wrote without `selected` was selected.
    if (result.selected === false) continue;
    summary.selected += 1;
    switch (result.status) {
      case 'passed':
        summary.passed += 1;
        break;
      case 'flaky':
        summary.flaky += 1;
        break;
      case 'failed':
      case 'timed-out':
        summary.failed += 1;
        break;
      case 'interrupted':
        summary.interrupted += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
    }
  }
  return summary;
}
