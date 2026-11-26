/**
 * The pull request comment the `microbench` workflow keeps current: the
 * `compare` job's table under a one-line headline, and whether the
 * `repeatability` job found the counts stable enough to trust it. Cases that
 * did not change are folded away, so the open table shows only what moved.
 */

import { comparisonIntro, comparisonTable, methodLines, repeatabilityFailures, type Result } from './markdown.ts';
import type { Direction } from './stats.ts';

/** The first line of the workflow's comment; the run edits the comment that carries it. */
export const COMMENT_MARKER = '<!-- microbench -->';

export interface CommentInput {
  /** The `compare` job's `result.json`, or undefined when the job or its download left none. */
  readonly compare: Result | undefined;
  /** The `repeatability` job's `result.json`, or undefined when the job or its download left none. */
  readonly repeatability: Result | undefined;
  readonly runUrl: string;
  /**
   * The pull request's head commit. The jobs measure GitHub's merge of it
   * into the base, so the table's head is that merge commit, which the pull
   * request does not list.
   */
  readonly head: string | undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the comparison says, in one line. */
function headline(compare: Result | undefined, runUrl: string): string {
  if (compare === undefined) {
    return `⚠️ No comparison result: the \`compare\` job did not finish, or its artifact could not be downloaded. See the [workflow run](${runUrl}).`;
  }
  const count = (verdict: Direction) => compare.rows.filter((row) => row.assessment?.verdict === verdict).length;
  const higher = count('higher');
  const lower = count('lower');
  const inconclusive = count('inconclusive');
  const parts = [
    ...(higher > 0 ? [`🔴 ${plural(higher, 'case costs', 'cases cost')} more`] : []),
    ...(lower > 0 ? [`🟢 ${plural(lower, 'case costs', 'cases cost')} less`] : []),
    ...(inconclusive > 0
      ? [`⚪ ${plural(inconclusive, 'case', 'cases')} moved by ${compare.thresholdPercent}% or more, but the trials do not confirm a direction`]
      : []),
  ];
  return parts.length === 0 ? `⚪ No case changed by ${compare.thresholdPercent}% or more.` : `${parts.join(', ')}.`;
}

/** Whether two builds of the head agreed, which is what makes the comparison worth reading. */
function repeatabilityLine(repeatability: Result | undefined): string {
  if (repeatability === undefined) {
    return '⚠️ No repeatability result: the `repeatability` job did not finish, or its artifact could not be downloaded, so the counts are not known to be stable.';
  }
  const failures = repeatabilityFailures(repeatability);
  if (failures.length === 0) return `Repeatability: two builds of the head agree in every case, ${repeatability.trials} trials each.`;
  const cases = failures.map((row) => `\`${row.case}\` (${row.mode})`).join(', ');
  return `⚠️ Repeatability check failed: two builds of the head landed apart in ${cases}. A direction below can be measurement noise.`;
}

/**
 * The comparison: the cases with a direction, or that moved past the floor
 * without one, in an open table, and the unchanged cases folded under it.
 */
function comparisonSection(compare: Result): string[] {
  const unchanged = compare.rows.filter((row) => row.assessment?.verdict === 'same');
  const changed = compare.rows.filter((row) => row.assessment !== undefined && row.assessment.verdict !== 'same');
  return [
    ...comparisonIntro(compare),
    ...(changed.length === 0 ? [] : comparisonTable(compare, changed)),
    ...(unchanged.length === 0
      ? []
      : [`<details><summary>${plural(unchanged.length, 'unchanged case', 'unchanged cases')}</summary>`, '', ...comparisonTable(compare, unchanged), '</details>', '']),
  ];
}

/** The whole comment body, opening with {@link COMMENT_MARKER}. */
export function renderComment({ compare, repeatability, runUrl, head }: CommentInput): string {
  return [
    COMMENT_MARKER,
    '### Microbenchmarks',
    '',
    ...(head === undefined ? [] : [`For \`${head.slice(0, 12)}\`, the pull request's head, measured merged into its base.`, '']),
    headline(compare, runUrl),
    '',
    repeatabilityLine(repeatability),
    '',
    ...(compare === undefined
      ? []
      : [...comparisonSection(compare), '<details><summary>How this is measured</summary>', '', ...methodLines(compare), '</details>', '']),
    `[Workflow run](${runUrl}): each job's summary, and \`result.json\` in its artifact.`,
    '',
  ].join('\n');
}
