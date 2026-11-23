/** The built-in `line` reporter: one row of progress, each failure as it happens, then the `list` reporter's summary. */

import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { Reporter } from '../run-types.ts';
import { STATUS_WORD, terminalColumns } from './format.ts';
import { ListReporter, runView } from './list.ts';
import { clampToWidth } from './live-window.ts';
import type { TerminalProgress } from './progress.ts';

/** Options of the built-in `line` reporter. */
export interface LineReporterOptions {
  /** The terminal stream it prints to; without it, `stdout`, or `stderr` beside `json`, as the `line` id. */
  readonly stream?: 'stdout' | 'stderr';
}

/**
 * The built-in `line` reporter: on a terminal, one row that names the test
 * that started or finished last; elsewhere, one row per finished test. A
 * failure prints when its result arrives, and the run ends with the summary
 * the `list` reporter prints.
 */
export function line(options: LineReporterOptions = {}): Reporter {
  const stream = options.stream ?? 'stdout';
  return runView('line', stream, options.stream === undefined, (output) => new ListReporter(output, { live: process[stream].isTTY === true, progress: new LineProgress() }));
}

/** The row of the `line` reporter: how many results are in, and the test that started or finished last. */
export class LineProgress implements TerminalProgress {
  readonly failureTiming = 'immediate';
  private total: number | undefined;
  private done = 0;
  private row: { readonly test: string; readonly state: string } | undefined;

  collected(total: number): void {
    this.total = total;
  }

  /** Tests that run at once share the row: whichever started or finished last has it. */
  started(name: string): void {
    this.row = { test: this.counted(name), state: ' (running)' };
  }

  finished(status: ResultStatus, name: string): string {
    this.done += 1;
    this.row = { test: this.counted(name), state: ` (${STATUS_WORD[status]})` };
    return this.row.test + this.row.state;
  }

  /** A row wider than the terminal clips the test, never its state. */
  rows(): readonly string[] {
    if (this.row === undefined) return [];
    const { test, state } = this.row;
    // One column more for the clip mark, so the window's own clamp of the whole row leaves the state alone.
    return [clampToWidth(test, terminalColumns() - state.length - 1) + state];
  }

  private counted(name: string): string {
    return `[${this.done}/${this.total ?? '?'}] ${name}`;
  }
}
