/** The built-in `dot` reporter: one mark per test, then the `list` reporter's failures and summary. */

import picocolors from 'picocolors';
import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { Reporter } from '../run-types.ts';
import type { Colors } from './format.ts';
import { ListReporter, runView } from './list.ts';
import type { TerminalProgress } from './progress.ts';

type OutputStream = 'stdout' | 'stderr';

/** Options of the built-in `dot` reporter. */
export interface DotReporterOptions {
  /** The terminal stream it prints to; without it, `stdout`, or `stderr` beside `json`, as the `dot` id. */
  readonly stream?: OutputStream;
}

/**
 * The built-in `dot` reporter: one mark per selected test as it finishes,
 * with what user code prints on its own lines, then the failures and the
 * summary the `list` reporter prints.
 */
export function dot(options: DotReporterOptions = {}): Reporter {
  const stream = options.stream ?? 'stdout';
  const write = (to: OutputStream, text: string): void => void process[to].write(text);
  return runView('dot', stream, options.stream === undefined, (output) => new ListReporter(output, { live: false, progress: new DotProgress(stream, write) }));
}

/** The marks of the `dot` reporter, and the user output it prints between them. */
export class DotProgress implements TerminalProgress {
  readonly failureTiming = 'at-end';
  private readonly marks: Record<ResultStatus, string>;
  private columns = 0;
  private readonly unfinished = new Set<OutputStream>();

  constructor(
    private readonly stream: OutputStream,
    private readonly output: (stream: OutputStream, text: string) => void,
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
  finished(status: ResultStatus): undefined {
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

  /** Ends the row of marks and any user output a newline has not, so a permanent line starts on its own. */
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
