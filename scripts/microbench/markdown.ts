/** The summary `scripts/microbench.ts` prints and writes to `summary.md`. */

import { format, type Assessment, type TrialSpread, type Tool } from './stats.ts';

export type Mode = 'jit' | 'jitless';

export interface SideResult {
  /** The checkout's commit, or `unknown` outside git. */
  readonly sha: string;
  /** One per-iteration cost per trial, in run order. */
  readonly perIteration: readonly number[];
  readonly spread: TrialSpread;
}

export interface BenchRow {
  readonly case: string;
  readonly mode: Mode;
  readonly head: SideResult;
  readonly base?: SideResult;
  readonly assessment?: Assessment;
}

export interface Result {
  readonly tool: Tool;
  readonly trials: number;
  readonly multiplier: number;
  readonly thresholdPercent: number;
  /** Base and head hold the same code (`--expect-same`, or one directory twice): the run is a repeatability check. */
  readonly expectSame: boolean;
  readonly flags: Readonly<Record<Mode, readonly string[]>>;
  readonly machine: string;
  readonly rows: readonly BenchRow[];
}

const MARKS: Record<Assessment['verdict'], string> = { lower: '🟢', higher: '🔴', same: '⚪', inconclusive: '⚪' };

/** A per-iteration cost: whole instructions, or nanoseconds shown as µs. */
function cost(tool: Tool, value: number): string {
  return tool === 'cachegrind' ? Math.round(value).toLocaleString('en-US') : `${(value / 1000).toFixed(2)} µs`;
}

function range(tool: Tool, spread: TrialSpread): string {
  return `${cost(tool, spread.min)} – ${cost(tool, spread.max)}`;
}

function spreadText(spread: TrialSpread): string {
  return `${spread.spreadPercent.toFixed(3)}%`;
}

/**
 * Rows that fail a repeatability check. Instruction counts fail on any
 * separation, below the noise floor too: two builds of the same code must
 * not land apart at all. Wall time fails only on a direction, since a few
 * rounds agree by chance.
 */
export function repeatabilityFailures(result: Result): BenchRow[] {
  if (!result.expectSame) return [];
  return result.rows.filter((row) =>
    result.tool === 'cachegrind'
      ? row.assessment?.separated === true
      : row.assessment?.verdict === 'lower' || row.assessment?.verdict === 'higher',
  );
}

/** How a result was measured: the unit, the trials, the machine, and each mode's Node flags. */
export function methodLines(result: Result): string[] {
  const unit = result.tool === 'cachegrind' ? 'instructions per iteration' : 'wall time per iteration';
  return [
    `${unit[0]?.toUpperCase()}${unit.slice(1)}: the difference between a run of N and of ${result.multiplier}N iterations, divided by ${result.multiplier - 1}N, so startup, loading, warmup, and compilation cancel. ${result.trials} trial(s) per case and checkout. Lower is better.`,
    '',
    `Machine: ${result.machine}.`,
    '',
    ...(Object.entries(result.flags) as [Mode, readonly string[]][])
      .filter(([mode]) => result.rows.some((row) => row.mode === mode))
      .map(([mode, flags]) => `- \`${mode}\`: \`node ${flags.join(' ')}\``),
    '',
  ];
}

/** A line naming both commits, and the rule a direction follows. */
export function comparisonIntro(result: Result): string[] {
  const { tool } = result;
  const first = result.rows[0];
  return [
    result.expectSame
      ? `Base and head hold the same code: a repeatability check. It fails when ${tool === 'cachegrind' ? 'the trial ranges of any case do not overlap, whatever the change' : 'any case reports a direction'}.`
      : `Base \`${first?.base?.sha.slice(0, 12) ?? 'unknown'}\`, head \`${first?.head.sha.slice(0, 12) ?? 'unknown'}\`.`,
    '',
    `A direction is reported only when ${tool === 'cachegrind' ? 'the trial ranges of base and head do not overlap' : 'every round agrees on it'} and the change is at least ${result.thresholdPercent}%.`,
    '',
  ];
}

/** The base-against-head table of `rows`; a row with no base or no assessment is left out. */
export function comparisonTable(result: Result, rows: readonly BenchRow[]): string[] {
  const { tool } = result;
  const lines = ['| Case | Mode | Base | Head | Change | Direction | Base spread | Head spread |', '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |'];
  for (const row of rows) {
    if (row.base === undefined || row.assessment === undefined) continue;
    const { verdict, reason, changePercent } = row.assessment;
    lines.push(
      `| \`${row.case}\` | ${row.mode} | ${cost(tool, row.base.spread.median)} | ${cost(tool, row.head.spread.median)} | ${format(changePercent)} | ${MARKS[verdict]} ${verdict} (${reason}) | ${spreadText(row.base.spread)} | ${spreadText(row.head.spread)} |`,
    );
  }
  lines.push('');
  return lines;
}

export function renderSummary(result: Result): string {
  const { tool } = result;
  const lines = ['### Microbenchmarks', '', ...methodLines(result)];
  if (result.rows.some((row) => row.base !== undefined)) return [...lines, ...comparisonIntro(result), ...comparisonTable(result, result.rows)].join('\n');
  lines.push(
    `Checkout \`${result.rows[0]?.head.sha.slice(0, 12) ?? 'unknown'}\`.`,
    '',
    '| Case | Mode | Median | Min – max | Spread |',
    '| --- | --- | ---: | ---: | ---: |',
    ...result.rows.map(
      (row) => `| \`${row.case}\` | ${row.mode} | ${cost(tool, row.head.spread.median)} | ${range(tool, row.head.spread)} | ${spreadText(row.head.spread)} |`,
    ),
    '',
  );
  return lines.join('\n');
}
