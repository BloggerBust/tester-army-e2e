/** Compact progress and user output for the terminal reporter. */

import picocolors from 'picocolors';
import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { Colors } from './format.ts';
import { writeTerminal, type OutputStream } from '../run/process-output.ts';

import type { TerminalProgress, TerminalProgressResult } from './progress.ts';

export class DotProgress implements TerminalProgress {
  readonly name = 'dot';
  private readonly marks: Record<ResultStatus, string>;
  private columns = 0;
  private readonly unfinished = new Set<OutputStream>();

  constructor(
    private readonly stream: OutputStream,
    private readonly output: (stream: OutputStream, text: string) => void = writeTerminal,
    colors = picocolors.isColorSupported,
  ) {
    const pc: Colors = picocolors.createColors(colors);
    this.marks = {
      passed: pc.green('.'),
      flaky: pc.yellow('~'),
      failed: pc.red('F'),
      'timed-out': pc.red('T'),
      interrupted: pc.yellow('I'),
      skipped: pc.gray('-'),
    };
  }

  /** A retry contributes just the one mark its final verdict calls for. */
  result({ status }: Pick<TerminalProgressResult, 'status'>): void {
    const prefix = this.unfinished.delete(this.stream) ? '\n' : '';
    this.output(this.stream, prefix + this.marks[status]);
    this.columns += 1;
    if (this.columns === 80) this.finishMarks();
  }

  /** Leaves a progress line before printing already-redacted user output. */
  show(stream: OutputStream, text: string): void {
    if (text === '') return;
    this.finishMarks();
    const destination = stream === 'stdout' ? this.stream : stream;
    this.output(destination, text);
    if (text.endsWith('\n')) this.unfinished.delete(destination);
    else this.unfinished.add(destination);
  }

  /** Finishes progress and any partial user output before the next permanent line. */
  settle(): void {
    this.finishMarks();
    for (const stream of this.unfinished) this.output(stream, '\n');
    this.unfinished.clear();
  }

  private finishMarks(): void {
    if (this.columns > 0) {
      this.output(this.stream, '\n');
      this.columns = 0;
    }
  }
}
