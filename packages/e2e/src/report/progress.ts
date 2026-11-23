/**
 * A compact view of progress, as `dot` and `line` have: it stands in for the
 * `list` reporter's running tree and per-test rows inside the same view, so
 * the header, failures, and summary stay the ones `list` prints.
 */

import type { ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { OutputStream } from '../run/process-output.ts';

export interface TerminalProgress {
  /** Whether a failure prints when its result arrives, or under `Failed Tests` once the run is over. */
  readonly failureTiming: 'immediate' | 'at-end';
  /** How many results the run will report. */
  collected?(total: number): void;
  /** A test began an attempt; `name` is its target, file, and title as the view prints them. */
  started?(name: string): void;
  /** A selected test's final result, after any retries; returns its row, which a view that paints no `rows` keeps in the log. */
  finished(status: ResultStatus, name: string): string | undefined;
  /** The rows a view on a terminal keeps painted under the log. */
  rows?(): readonly string[];
  /** Prints already-redacted user output itself, in place of the view's headed lines. */
  show?(stream: OutputStream, text: string): void;
  /** Leaves the terminal ready for a permanent line. */
  settle?(): void;
}
