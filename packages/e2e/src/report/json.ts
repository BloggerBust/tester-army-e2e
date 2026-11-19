/** The built-in `json` reporter: the report document to stdout, and nothing else there. */

import { builtin } from './builtin-id.ts';
import type { Reporter } from '../run-types.ts';

/**
 * Prints the run's report-1 document to stdout once the run is over. It
 * prints to stdout, so what the runner prints itself goes to stderr.
 */
export function json(): Reporter {
  return builtin('json', {
    name: 'json',
    printsTo: 'stdout',
    async onRunFinished(run) {
      process.stdout.write(`${JSON.stringify(run.report, null, 2)}\n`);
    },
  });
}
