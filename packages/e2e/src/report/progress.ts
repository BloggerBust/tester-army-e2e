import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { OutputStream } from '../run/process-output.ts';
import type { TerminalReporterId } from './builtin.ts';

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
  readonly name: Exclude<TerminalReporterId, 'list'>;
  plan?(total: number): void;
  /** A selected test started an attempt: its first, or a retry. */
  start?(row: TerminalProgressTest): void;
  result(result: TerminalProgressResult): void;
  /** Handles redacted user output when the mode prints it without headings. */
  show?(stream: OutputStream, text: string): void;
  /** Leaves the terminal ready for permanent output. */
  settle(): void;
}
