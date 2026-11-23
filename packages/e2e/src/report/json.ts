/** The built-in `json` reporter: the report document to stdout, and nothing else there. */

import { builtin } from './builtin-id.ts';
import type { FinishedRun, Reporter } from '../run-types.ts';

/**
 * Prints the run's report-1 document to stdout once the report is written,
 * without waiting for another reporter's `onRunFinished`. A forced stop
 * skips `onRunFinished` but never `onSummary`, which prints the document
 * then. It is not interactive, so beside it alone the runner prints on
 * stderr.
 */
export function json(): Reporter {
  const printed = new WeakSet<FinishedRun>();
  const print = (run: FinishedRun): void => {
    if (printed.has(run)) return;
    printed.add(run);
    process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
  };
  return builtin('json', {
    name: 'json',
    onRunFinished(run) {
      print(run);
      return Promise.resolve();
    },
    onSummary(_rows, run) {
      print(run);
    },
  }, true);
}
