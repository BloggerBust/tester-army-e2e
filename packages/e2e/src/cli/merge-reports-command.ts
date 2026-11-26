import { InvalidArgumentError, type Command } from 'commander';
import { FINISHED_BUILTIN_REPORTERS } from '../report/builtin-id.ts';
import type { BuiltinReporter } from '../run-types.ts';
import { docsLine } from './help.ts';
import { parseList } from './parse-names.ts';

function parseFinishedReporters(value: string): BuiltinReporter[] {
  const ids = parseList(value);
  if (ids.length === 0) throw new InvalidArgumentError('must name at least one reporter');
  return ids.map((id) => {
    const reporter = FINISHED_BUILTIN_REPORTERS.find((candidate) => candidate === id);
    if (reporter === undefined) {
      throw new InvalidArgumentError(`unknown finished-run reporter "${id}"; expected ${FINISHED_BUILTIN_REPORTERS.join(', ')}`);
    }
    return reporter;
  });
}

export function registerMergeReportsCommand(program: Command): void {
  program
    .command('merge-reports')
    .summary('merge finished shard reports and their local artifacts')
    .argument('<directories...>', 'shard output directories, one per shard')
    .requiredOption('--output <dir>', 'new directory for the merged report and artifacts')
    .option('--config <path>', 'config file for finished-run reporters (default: the nearest e2e.config file)')
    .option('--reporter <ids>', `comma-separated built-in reporters: ${FINISHED_BUILTIN_REPORTERS.join(', ')}`, parseFinishedReporters)
    .addHelpText('after', `\n${docsLine('/reference/cli#e2e-merge-reports')}`)
    .action(async (directories: string[], options: { output: string; config?: string; reporter?: BuiltinReporter[] }) => {
      const { mergeReports } = await import('./merge-reports.ts');
      process.exitCode = await mergeReports(directories, options);
    });
}
