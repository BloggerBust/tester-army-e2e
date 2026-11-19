import type { Reporter } from '../run-types.ts';
import { ListReporter, runView } from './list.ts';
import { bounded, fitColumns } from './format.ts';
import type { TerminalProgress, TerminalProgressResult, TerminalProgressTest } from './progress.ts';

/** Options of the built-in `line` reporter. */
export interface LineReporterOptions {
  /** Defaults to stdout, or stderr alongside the JSON reporter. */
  readonly stream?: 'stdout' | 'stderr';
}

/** Shows the active test or latest selected result on one terminal row. */
export function line(options: LineReporterOptions = {}): Reporter {
  const stream = options.stream ?? 'stdout';
  return runView('line', stream, options.stream === undefined, (output) => {
    const destination = process[stream];
    const progress = new LineProgress({
      write: output.raw,
      interactive: destination.isTTY === true && process.env.TERM !== 'dumb',
      columns: () => destination.columns || 80,
    });
    return new ListReporter(output, { progress });
  });
}

interface LineProgressOutput {
  readonly write: (text: string) => void;
  readonly interactive: boolean;
  /** Returns the current terminal width, including after resizing. */
  readonly columns: () => number;
}

const ERASE_ROW = '\r\u001b[2K';

export class LineProgress implements TerminalProgress {
  readonly name = 'line';
  private total: number | undefined;
  private completed = 0;
  private visible = false;

  constructor(private readonly output: LineProgressOutput) {}

  plan(total: number): void {
    this.total = total;
    this.completed = 0;
  }

  /**
   * Shows the most recent test start reported by the runner beside the
   * count of finished tests. One row cannot follow every worker, so the latest
   * start or result replaces it.
   */
  start(row: TerminalProgressTest): void {
    if (!this.output.interactive || !this.total) return;
    this.draw(this.label(row), ' (running)');
  }

  /** Reports a selected test's final result after any retries. */
  result(row: TerminalProgressResult): string | void {
    this.completed += 1;
    const label = this.label(row);
    const verdict = ` (${row.status})`;
    if (!this.output.interactive) return `${label}${verdict}`;
    this.draw(label, verdict);
  }

  settle(): void {
    if (!this.visible) return;
    this.output.write(ERASE_ROW);
    this.visible = false;
  }

  private label(row: TerminalProgressTest): string {
    return oneLine(`[${this.completed}/${this.total ?? '?'}] [${row.target}] ${row.file} > ${row.title}`);
  }

  private draw(label: string, verdict: string): void {
    // Leave a spare column so the terminal can erase the update as one row.
    const width = Math.max(1, this.output.columns() - 1);
    const fitted = width > verdict.length ? `${fitColumns(label, width - verdict.length)}${verdict}` : fitColumns(verdict, width);
    this.output.write(`${ERASE_ROW}${fitted}`);
    this.visible = true;
  }
}

/** Keeps line breaks in user labels from creating extra terminal rows. */
function oneLine(text: string): string {
  return bounded(text).replace(/[\r\n]+/g, ' ');
}
