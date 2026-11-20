import type { Reporter } from '../run-types.ts';
import { ListReporter, runView } from './list.ts';
import { bounded, fitColumns } from './format.ts';
import { cursorRow, type TerminalProgress, type TerminalProgressResult, type TerminalProgressTest } from './progress.ts';

export interface LineReporterOptions {
  /** Defaults to stdout, or stderr alongside the JSON reporter. */
  readonly stream?: 'stdout' | 'stderr';
}

/** Shows the active test or latest selected result on one terminal row. */
export function line(options: LineReporterOptions = {}): Reporter {
  const stream = options.stream ?? 'stdout';
  const cursor = { exclusive: false };
  const reporter = runView('line', stream, options.stream === undefined, (output) => {
    const destination = process[stream];
    // Consume the grant so it cannot carry into another run.
    const granted = cursor.exclusive;
    cursor.exclusive = false;
    const progress = new LineProgress({
      write: output.raw,
      interactive: granted && destination.isTTY === true && process.env.TERM !== 'dumb',
      columns: () => destination.columns || 80,
    });
    return new ListReporter(output, { progress });
  });
  cursorRow.set(reporter, cursor);
  return reporter;
}

interface LineProgressOutput {
  readonly write: (text: string) => void;
  readonly interactive: boolean;
  readonly columns: () => number;
}

const ERASE_ROW = '\r\u001b[2K';

export class LineProgress implements TerminalProgress {
  readonly failureTiming = 'immediate';
  private total: number | undefined;
  private completed = 0;
  private visible = false;

  constructor(private readonly output: LineProgressOutput) {}

  plan(total: number): void {
    this.total = total;
    this.completed = 0;
  }

  /** Concurrent tests share one row. Each start or final result replaces its contents. */
  start(row: TerminalProgressTest): void {
    if (!this.output.interactive || !this.total) return;
    this.draw(this.label(row), ' (running)');
  }

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

function oneLine(text: string): string {
  return bounded(text).replace(/[\r\n]+/g, ' ');
}
