/**
 * The runner's side of its reporters: who gets each event, who shows the run
 * to a person, what the runner prints when nobody does, and how the
 * reporters finish once the report is written.
 */

import path from 'node:path';
import { leaveWorkBehind } from '@e2e-dev/core/lib/internal/abandoned';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { budgetText, withAbort } from '@e2e-dev/core/lib/internal/time';
import { builtinId } from '../report/builtin-id.ts';
import { pauseLinePrinter } from '../report/list-steps.ts';
import { writeTextReport } from '../report/write.ts';
import type { FinishedRun, ReportFile, Reporter, ReporterSummary } from '../run-types.ts';
import { createRunEventEmitter, type RunEvent, type RunEventFact, type RunEventOf, type RunEventSink, type RunEventSubscriber } from './events.ts';
import { uncaptured, writeTerminal, type RunnerOutput } from './process-output.ts';

/** Why a reporter's `onRunFinished` was given up on: the message is the stderr line. */
class ReporterAbandoned extends Error {}

/** What the host needs of the run beside its reporters. */
interface HostOptions {
  /** The process's user output; undefined in a run that claims none. */
  readonly processOutput: RunnerOutput | undefined;
  /** An embedded run: the runner prints no test's output itself. */
  readonly quiet: boolean;
  /** Masks the config's fixed secret values in a line the runner prints. */
  readonly redact: (text: string) => string;
  /** The embedding program's own sink, after the reporters'. */
  readonly onEvent: RunEventSink | undefined;
  /** Budget for each reporter's `reportFiles` and `onRunFinished`. */
  readonly timeoutMs: number;
  /** Aborts when the run is forced to stop. */
  readonly force: AbortSignal;
}

/** A run's reporters as the runner drives them. */
interface ReporterHost {
  /** Emits one fact to every reporter's `onEvent`, the embedder's sink, and the runner's own printing; for `'viewers'`, only to whoever shows the run. */
  emit(fact: RunEventFact, audience?: 'viewers'): void;
  /** Whether an interactive reporter shows the run, so the runner prints no output, run error, or pause itself; false once its `onEvent` broke. */
  showsRun(): boolean;
  /** Finishes every reporter once the report is written: its files, its `onRunFinished`, then its `onSummary`. */
  finish(finished: FinishedRun): Promise<void>;
}

/**
 * Calls a finished-run hook of `reporter`, or its `onEvent`. An interactive
 * reporter's output is what the terminal shows, as written. The `json`
 * reporter's is the run's document, alone on stdout. Any other reporter
 * prints as user code does, redacted; its `summary` prints on the stream it
 * wrote to, stdout included, unless the document is there.
 */
function inContext<T>(reporter: Reporter, processOutput: RunnerOutput | undefined, hook: () => T, summary = false): T {
  if (processOutput === undefined) return reporter.interactive === true ? uncaptured(hook) : hook();
  if (builtinId(reporter) === 'json') return processOutput.asDocument(hook);
  if (reporter.interactive === true) return processOutput.asWritten(hook);
  return summary ? processOutput.asPrinted(hook) : hook();
}

/**
 * Hosts `reporters` for one run. Every reporter with `onEvent` gets every
 * event, but only an interactive one stands in for the runner's own
 * printing: a reporter that only records never silences it, and once an
 * interactive reporter's `onEvent` throws or rejects, the runner prints
 * what it showed.
 *
 * What a sink prints while it is handed output, now or after an `await`,
 * is output only whoever shows the run gets: the interactive reporter, or
 * the runner's own printing. It never comes back to the sink, so one that
 * logs what it is handed cannot feed itself.
 */
export function hostReporters(reporters: readonly Reporter[], options: HostOptions): ReporterHost {
  const { processOutput } = options;
  const showing = new Set(reporters.filter((reporter) => reporter.interactive === true && reporter.onEvent !== undefined));
  const showsRun = (): boolean => showing.size > 0;
  const plain = plainView(showsRun, options);
  /** A sink that is handed output inside `passThrough`. */
  const handing = (sink: RunEventSink): RunEventSink =>
    processOutput === undefined ? sink : (event) => (event.type === 'output' ? processOutput.passThrough(() => sink(event)) : sink(event));
  const sinks: RunEventSubscriber[] = reporters.flatMap((reporter) => {
    const { onEvent } = reporter;
    if (onEvent === undefined) return [];
    return [
      {
        name: reporter.name,
        ...(reporter.interactive === true ? { viewer: true as const } : {}),
        onEvent: handing((event) => inContext(reporter, processOutput, () => onEvent.call(reporter, event))),
        // The runner shows the pause the last interactive reporter was showing.
        onQuarantine: () => {
          if (showing.delete(reporter) && !showsRun()) plain.show();
        },
      },
    ];
  });
  const emit = createRunEventEmitter(
    [
      // First, so a reporter that breaks on a pause leaves the runner showing the current one.
      { name: 'runner (tracking pauses)', viewer: true, onEvent: plain.track },
      ...sinks,
      ...(options.onEvent === undefined ? [] : [{ name: 'onEvent', onEvent: handing(options.onEvent) }]),
      // Last, once every reporter had its chance to show the event.
      { name: 'runner (printing)', viewer: true, onEvent: plain.print },
    ],
    // The runner's own line, outside any reporter's output context, so it is redacted like any other.
    (line) => {
      const write = (): unknown => process.stderr.write(line);
      if (processOutput === undefined) write();
      else processOutput.captured(write);
    },
  );
  return { emit, showsRun, finish: (finished) => finishReporters(reporters, finished, options) };
}

export function hasFinishedRunHook(reporter: Reporter): boolean {
  return reporter.onRunFinished !== undefined || reporter.reportFiles !== undefined || reporter.onSummary !== undefined;
}

/**
 * What the runner prints itself while no interactive reporter shows the
 * run, always on stderr: what user code prints, a test's unless the run is
 * quiet, and a test waiting for a key as one line. `track` follows the
 * waits whoever shows them, so `show` can take one over.
 */
function plainView(showsRun: () => boolean, { processOutput, quiet, redact }: HostOptions): { track(event: RunEvent): void; print(event: RunEvent): void; show(): void } {
  let waiting: RunEventOf<'paused'> | undefined;
  // Straight to the terminal, redacted here, so nothing holds the line back while the run waits.
  const printPause = pauseLinePrinter((line) => writeTerminal('stderr', `${redact(line)}\n`));
  const show = (): void => {
    if (!showsRun()) printPause(waiting);
  };
  return {
    track(event) {
      if (event.type === 'paused') waiting = event;
      else if (event.type === 'resumed') waiting = undefined;
    },
    print(event) {
      if (event.type === 'paused' || event.type === 'resumed') show();
      else if (event.type === 'output' && !showsRun() && (event.target === undefined || !quiet)) processOutput?.print(event.stream, event.text);
    },
    show,
  };
}

/** What a reporter's `reportFiles` has left once the run is forced to stop. */
const FORCED_REPORT_FILES_MS = 5_000;

/**
 * Finishes every reporter: first the files each one's `reportFiles`
 * renders, which the runner writes, then every `onRunFinished` at once,
 * then every `onSummary` with the rows they all came back with. Each call
 * has `timeoutMs` and a signal that aborts on it; a forced stop also aborts
 * `onRunFinished`, except an interactive reporter's, whose output is local,
 * and leaves `reportFiles` a few seconds more, so the previous run's file
 * rarely stays beside this run's `report.json` and the stop never hangs on
 * one. A reporter given up on is work left
 * behind, which the CLI does not wait for. A reporter that throws, runs out
 * of time, or returns something other than files or rows is one line on
 * stderr; it can never change the run's outcome.
 */
export async function finishReporters(reporters: readonly Reporter[], finished: FinishedRun, { timeoutMs, force, processOutput }: Pick<HostOptions, 'timeoutMs' | 'force' | 'processOutput'>): Promise<void> {
  const say = (reporter: Reporter, detail: string): void => {
    process.stderr.write(`e2e: reporter "${reporter.name}" ${detail}\n`);
  };
  const budget = budgetText(timeoutMs);
  const forced = 'abandoned: the run was forced to stop';

  /**
   * Awaits `call` within the budget; undefined when it failed, a stderr line
   * said why. A forced stop leaves it `forcedGraceMs` more, none at all for
   * 0, and does not cut it short when undefined.
   */
  const bounded = async <T,>(reporter: Reporter, forcedGraceMs: number | undefined, call: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> => {
    if (forcedGraceMs === 0 && force.aborted) {
      say(reporter, forced);
      return undefined;
    }
    const abandon = new AbortController();
    const timer = setTimeout(() => abandon.abort(new ReporterAbandoned(`did not finish within ${budget}`)), timeoutMs);
    let forcedTimer: NodeJS.Timeout | undefined;
    const onForce = (): void => {
      // No grace is none: a timer would let a hook that settles in the same turn through.
      if (forcedGraceMs === 0) abandon.abort(new ReporterAbandoned(forced));
      else forcedTimer = setTimeout(() => abandon.abort(new ReporterAbandoned(forced)), forcedGraceMs);
    };
    if (forcedGraceMs !== undefined) {
      if (force.aborted) onForce();
      else force.addEventListener('abort', onForce, { once: true });
    }
    try {
      return await withAbort(() => call(abandon.signal), abandon.signal, () => abandon.signal.reason as ReporterAbandoned);
    } catch (cause) {
      if (cause instanceof ReporterAbandoned) leaveWorkBehind();
      say(reporter, cause instanceof ReporterAbandoned ? cause.message : `failed: ${errorMessage(cause)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
      clearTimeout(forcedTimer);
      force.removeEventListener('abort', onForce);
    }
  };

  const fileRows = await Promise.all(
    reporters.map(async (reporter): Promise<ReporterSummary> => {
      const { reportFiles } = reporter;
      if (reportFiles === undefined) return [];
      const files = await bounded(reporter, FORCED_REPORT_FILES_MS, async (signal) => inContext(reporter, processOutput, () => reportFiles.call(reporter, finished, signal)));
      if (files === undefined) return [];
      if (!Array.isArray(files) || !files.every(isReportFile)) {
        say(reporter, 'returned something other than report files; wrote none');
        return [];
      }
      return writeReportFiles(reporter, files, finished, say);
    }),
  );

  const finishedRows = await Promise.all(
    reporters.map(async (reporter): Promise<ReporterSummary> => {
      const { onRunFinished } = reporter;
      if (onRunFinished === undefined) return [];
      const result: unknown = await bounded(reporter, reporter.interactive === true ? undefined : 0, (signal) => Promise.resolve(inContext(reporter, processOutput, () => onRunFinished.call(reporter, finished, signal))));
      if (result === undefined) return [];
      if (!Array.isArray(result)) {
        say(reporter, 'returned something other than summary rows; dropped');
        return [];
      }
      const rows = result.filter(isSummaryRow);
      const dropped = result.length - rows.length;
      if (dropped > 0) say(reporter, `returned ${dropped} row(s) without a label and text; dropped`);
      return rows;
    }),
  );

  const rows = fileRows.flatMap((files, index) => [...files, ...(finishedRows[index] ?? [])]);
  for (const reporter of reporters) {
    if (reporter.onSummary === undefined) continue;
    const broke = (cause: unknown): void => say(reporter, `threw in onSummary: ${errorMessage(cause)}`);
    try {
      // An async hook is never awaited, but its rejection is caught; a
      // thenable is adopted inside the hook's own output context.
      const result = inContext(reporter, processOutput, () => {
        const value: unknown = reporter.onSummary?.(rows, finished);
        return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function' ? Promise.resolve(value) : undefined;
      }, true);
      result?.catch(broke);
    } catch (cause) {
      broke(cause);
    }
  }
}

/**
 * Writes one reporter's files atomically, each whose path is not the
 * canonical report, and answers the rows naming the ones with a label. A
 * file that could not be written is one line on stderr.
 */
async function writeReportFiles(
  reporter: Reporter,
  files: readonly ReportFile[],
  finished: FinishedRun,
  say: (reporter: Reporter, detail: string) => void,
): Promise<ReporterSummary> {
  const rows: { label: string; text: string }[] = [];
  for (const file of files) {
    const target = path.resolve(finished.projectRoot, file.path);
    if (finished.reportPath !== undefined && target === path.resolve(finished.reportPath)) {
      say(reporter, `cannot write ${file.path}: it is the run's report`);
      continue;
    }
    try {
      await writeTextReport(target, file.content);
    } catch (cause) {
      say(reporter, `could not write ${file.path}: ${errorMessage(cause)}`);
      continue;
    }
    if (file.label === undefined) continue;
    const shown = path.relative(finished.projectRoot, target) || target;
    rows.push({ label: file.label, text: file.note === undefined ? shown : `${shown} ${file.note}` });
  }
  return rows;
}

/** A report file is a non-empty path and string content, with an optional label and note; anything else came from untyped code. */
function isReportFile(value: unknown): value is ReportFile {
  if (typeof value !== 'object' || value === null) return false;
  const { path: file, content, label, note } = value as Record<keyof ReportFile, unknown>;
  const optionalText = (text: unknown): boolean => text === undefined || (typeof text === 'string' && text.length > 0);
  return typeof file === 'string' && file.length > 0 && typeof content === 'string' && optionalText(label) && optionalText(note);
}

/** A row is a non-empty label and non-empty text; anything else came from untyped code. */
function isSummaryRow(value: unknown): value is ReporterSummary[number] {
  if (typeof value !== 'object' || value === null) return false;
  const { label, text } = value as { label?: unknown; text?: unknown };
  return typeof label === 'string' && label.length > 0 && typeof text === 'string' && text.length > 0;
}

