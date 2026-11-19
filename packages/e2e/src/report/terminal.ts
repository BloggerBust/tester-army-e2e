/** Constructs the run's terminal view and built-in reporter sinks. */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { writeTerminal, type OutputStream, type OutputView, type RunnerOutput } from '../run/process-output.ts';
import { isTerminalReporter, STATELESS_REPORTERS, TERMINAL_REPORTERS, type TerminalReporterId } from './builtin.ts';
import { DotProgress } from './dot.ts';
import { LineProgress, type LineProgressOutput } from './line.ts';
import { ListReporter } from './list.ts';
import type { TerminalProgress } from './progress.ts';

type ReporterWrite = (stream: OutputStream, text: string) => void;

const progressFactories: Record<TerminalReporterId, (stream: OutputStream, write: ReporterWrite) => TerminalProgress | undefined> = {
  list: () => undefined,
  dot: (stream, write) => new DotProgress(stream, write),
  line: (stream, write) => new LineProgress(lineOutput(stream, write)),
};

export function createReporters(
  ids: readonly BuiltinReporter[],
  custom: readonly Reporter[],
  options: { quiet: boolean; stepping: boolean; output: RunnerOutput | undefined },
): { terminal: ListReporter | undefined; reporters: readonly Reporter[]; view: OutputView | undefined } {
  const mode = TERMINAL_REPORTERS.find((id) => ids.includes(id));
  const stream = ids.includes('json') ? 'stderr' : 'stdout';
  const write = options.output?.reporterOutput ?? writeTerminal;
  const progress = options.quiet || mode === undefined ? undefined : progressFactories[mode](stream, write);
  const terminal = options.quiet || mode === undefined ? undefined : new ListReporter(
    { write: (line) => write(stream, `${line}\n`), raw: (text) => write(stream, text) },
    { stepping: options.stepping, ...(progress === undefined ? {} : { progress }) },
  );
  return {
    terminal,
    reporters: [
      ...(terminal === undefined ? [] : [terminal]),
      ...ids.filter((id) => !isTerminalReporter(id)).map((id) => STATELESS_REPORTERS[id]),
      ...custom,
    ],
    view: terminal === undefined ? undefined : {
      show: (source, text) => terminal.processOutput(source, text),
      end: () => terminal.endProcessOutput(),
    },
  };
}

/** Check the destination stream so terminal progress works when JSON is written to stdout. */
function lineOutput(stream: OutputStream, write: ReporterWrite): LineProgressOutput {
  const destination = stream === 'stderr' ? process.stderr : process.stdout;
  return {
    write: (text) => write(stream, text),
    interactive: destination.isTTY === true && process.env.TERM !== 'dumb',
    columns: () => destination.columns || 80,
  };
}
