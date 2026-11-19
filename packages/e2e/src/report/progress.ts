import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { OutputStream } from '../run/process-output.ts';

/** A selected test as a progress row names it. */
export interface TerminalProgressTest {
  readonly target: string;
  readonly file: string;
  /** The title as the reporter prints it, with its agent and repeat suffixes. */
  readonly title: string;
}

export interface TerminalProgressResult extends TerminalProgressTest {
  readonly status: ResultStatus;
}

export interface TerminalProgress {
  readonly name: 'dot' | 'line';
  plan?(total: number): void;
  /** The runner announced a selected test start. */
  start?(row: TerminalProgressTest): void;
  /** Returns a permanent row for the view to print when the renderer needs one. */
  result(result: TerminalProgressResult): string | void;
  /** Handles redacted user output when the mode prints it without headings. */
  show?(stream: OutputStream, text: string): void;
  /** Leaves the terminal ready for permanent output. */
  settle(): void;
}
