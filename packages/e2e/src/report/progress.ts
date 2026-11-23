import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { OutputStream } from '../run/process-output.ts';

export interface TerminalProgressTest {
  readonly target: string;
  readonly file: string;
  /** Includes any repeat and agent suffixes. */
  readonly title: string;
}

export interface TerminalProgressResult extends TerminalProgressTest {
  readonly status: ResultStatus;
}

export interface TerminalProgress {
  readonly failureTiming: 'immediate' | 'at-end';
  plan?(total: number): void;
  start?(row: TerminalProgressTest): void;
  /**
   * Called once per selected test, after any retries. Return a permanent row so the view
   * can reset the log heading, or write progress directly and return nothing.
   */
  result(result: TerminalProgressResult): string | void;
  /** Handles redacted user output when the mode prints it without headings. */
  show?(stream: OutputStream, text: string): void;
  /** Leaves the terminal ready for permanent output. */
  settle(): void;
}
