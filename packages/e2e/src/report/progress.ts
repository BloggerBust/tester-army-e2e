import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { OutputStream } from '../run/process-output.ts';

/** A line view consumes this grant at startup if the runner has reserved the cursor row for it. */
export const cursorRow = realmSlot<{ exclusive: boolean }>('e2e.reporter.cursor-row');

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
  readonly failureTiming: 'immediate' | 'at-end';
  plan?(total: number): void;
  /** The runner announced a selected test start. */
  start?(row: TerminalProgressTest): void;
  /** Return a permanent row so the view can reset the log heading, or write progress directly and return nothing. */
  result(result: TerminalProgressResult): string | void;
  /** Handles redacted user output when the mode prints it without headings. */
  show?(stream: OutputStream, text: string): void;
  /** Leaves the terminal ready for permanent output. */
  settle(): void;
}
