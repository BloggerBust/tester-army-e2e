/** Constructs the run's terminal view and built-in reporter sinks. */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { writeTerminal, type OutputView, type RunnerOutput } from '../run/process-output.ts';
import { STATELESS_REPORTERS } from './builtin.ts';
import { DotProgress } from './dot.ts';
import { ListReporter } from './list.ts';

export function createReporters(
  ids: readonly BuiltinReporter[],
  custom: readonly Reporter[],
  options: { quiet: boolean; stepping: boolean; output: RunnerOutput | undefined },
): { terminal: ListReporter | undefined; reporters: readonly Reporter[]; view: OutputView | undefined } {
  const mode = ids.includes('list') ? 'list' : ids.includes('dot') ? 'dot' : undefined;
  const stream = ids.includes('json') ? 'stderr' : 'stdout';
  const write = options.output?.reporterOutput ?? writeTerminal;
  const terminal = options.quiet || mode === undefined ? undefined : new ListReporter(
    { write: (line) => write(stream, `${line}\n`), raw: (text) => write(stream, text) },
    { stepping: options.stepping, ...(mode === 'dot' ? { dots: new DotProgress(stream, write) } : {}) },
  );
  return {
    terminal,
    reporters: [
      ...(terminal === undefined ? [] : [terminal]),
      ...ids.filter((id) => id !== 'list' && id !== 'dot').map((id) => STATELESS_REPORTERS[id]),
      ...custom,
    ],
    view: terminal === undefined ? undefined : {
      show: (source, text) => terminal.processOutput(source, text),
      end: () => terminal.endProcessOutput(),
    },
  };
}
