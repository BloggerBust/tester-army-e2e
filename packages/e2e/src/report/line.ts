import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import { bounded, fitColumns } from './format.ts';

export interface LineProgressOutput {
  readonly write: (text: string) => void;
  readonly interactive: boolean;
  /** Returns the current terminal width, including after resizing. */
  readonly columns: () => number;
}

interface LineProgressRow {
  readonly target: string;
  readonly file: string;
  readonly title: string;
  readonly status: ResultStatus;
}

const ERASE_ROW = '\r\u001b[2K';

export class LineProgress {
  private total: number | undefined;
  private completed = 0;
  private visible = false;

  constructor(private readonly output: LineProgressOutput) {}

  plan(total: number): void {
    this.total = total;
    this.completed = 0;
  }

  /** Reports a selected test's final result after any retries. */
  result(row: LineProgressRow): void {
    if (this.total === undefined) return;
    this.completed += 1;
    const label = oneLine(`[${this.completed}/${this.total}] [${row.target}] ${row.file} > ${row.title}`);
    const verdict = ` (${row.status})`;
    if (this.output.interactive) {
      // Leave a spare column so the terminal can erase the update as one row.
      const width = Math.max(1, this.output.columns() - 1);
      const fitted = width > verdict.length ? `${fitColumns(label, width - verdict.length)}${verdict}` : fitColumns(verdict, width);
      this.output.write(`${ERASE_ROW}${fitted}`);
      this.visible = true;
    } else {
      this.output.write(`${label}${verdict}\n`);
    }
  }

  clear(): void {
    if (!this.visible) return;
    this.output.write(ERASE_ROW);
    this.visible = false;
  }
}

/** Keeps line breaks in user labels from creating extra terminal rows. */
function oneLine(text: string): string {
  return bounded(text).replace(/[\r\n]+/g, ' ');
}
