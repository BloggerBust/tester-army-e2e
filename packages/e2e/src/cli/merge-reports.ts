import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveAvailableSecrets, resolveOutputDir } from '@e2e-dev/core/lib/config/resolve';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { isStrictlyInside, realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { redactError, registerStaticSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { discoverConfig, loadConfigModule } from '../config/load.ts';
import { resolveReporters } from '../config/resolve-run.ts';
import { builtinId } from '../report/builtin-id.ts';
import type { Report1Document } from '../report/build.ts';
import { copyMergedArtifacts } from '../report/merge-artifacts.ts';
import { readShard, type ShardInput } from '../report/merge-input.ts';
import { mergeShardReports } from '../report/merge.ts';
import { writeTracePages, type TracePages } from '../report/traces.ts';
import { writeJsonReport } from '../report/write.ts';
import { finishReporters, hasFinishedRunHook } from '../run/reporter-host.ts';
import type { BuiltinReporter } from '../run-types.ts';
import { claimRunnerOutput } from './run-output.ts';

interface MergeOptions {
  readonly config?: string;
  readonly output: string;
  readonly reporter?: readonly BuiltinReporter[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

function tracedResults(report: Report1Document): Set<string> {
  const groups = new Map(report.run.serialGroups.map((group) => [group.id, group]));
  const ids = new Set<string>();
  for (const result of report.run.results) {
    const attempts = result.serialGroupId === undefined ? result.attempts : groups.get(result.serialGroupId)?.attempts ?? [];
    if (attempts.length > 0) ids.add(result.id);
  }
  return ids;
}

async function publishMerged(
  report: Report1Document,
  inputs: readonly ShardInput[],
  output: string,
  projectRoot: string,
): Promise<TracePages> {
  await mkdir(path.dirname(output), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(output), '.e2e-merge-'));
  try {
    // Keep the incomplete report private, then publish a directory created
    // with the same permissions as an ordinary run output.
    const pending = outputLayout(path.join(staging, 'output'));
    const published = outputLayout(output);
    await copyMergedArtifacts(report, inputs, pending.results);
    const traces = await writeTracePages(report, tracedResults(report), {
      projectRoot,
      resultsRoot: pending.results,
      publishedResultsRoot: published.results,
    });
    await writeJsonReport(pending.report, report);
    if (await exists(output)) throw new Error('--output must be a new directory');
    await rename(path.dirname(pending.report), output);
    return traces;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function mergeReports(directories: readonly string[], options: MergeOptions): Promise<number> {
  const terminal = claimRunnerOutput();
  try {
    const cwd = process.cwd();
    const discovered = discoverConfig(cwd, options.config);
    const projectRoot = options.config === undefined ? discovered.projectRoot : discoverConfig(discovered.projectRoot).projectRoot;
    const outputDir = resolveOutputDir(undefined, options.output, discovered.projectRoot);
    const output = realpathOfExisting(outputDir);
    const roots = directories.map((directory) => path.resolve(cwd, directory));
    const outputIsInside = (input: string): boolean => input === output || isStrictlyInside(input, output);
    if (await exists(outputDir) || roots.some((input) => outputIsInside(realpathOfExisting(input)))) {
      throw new Error('--output must be a new directory outside the shard inputs');
    }
    const reporters = await terminal.withholdDuring(async () => {
      const raw = discovered.configPath === undefined ? undefined : await loadConfigModule(discovered.configPath);
      if (raw !== undefined) registerStaticSecrets(resolveAvailableSecrets(raw, process.env));
      const configured = resolveReporters(
        { reporters: raw?.reporters ?? [] },
        options.reporter === undefined ? {} : { reporters: options.reporter },
      );
      if (configured.some((reporter) => builtinId(reporter) === 'json')) terminal.reserveStdout();
      return configured;
    });
    for (const reporter of reporters) {
      if (!hasFinishedRunHook(reporter)) {
        throw new Error(`reporter "${reporter.name}" needs live events; choose a finished-run reporter`);
      }
    }
    const inputs = [];
    for (const directory of roots) inputs.push(await readShard(directory));
    if (inputs.some(({ directory }) => outputIsInside(directory))) {
      throw new Error('--output must be a new directory outside the shard inputs');
    }
    const { report, warnings } = mergeShardReports(inputs);
    for (const warning of warnings) process.stderr.write(`e2e: warning: ${warning}\n`);

    const traces = await publishMerged(report, inputs, output, projectRoot);
    const layout = outputLayout(output);
    const { exitCode, status, summary } = report.run;
    await finishReporters(reporters, {
      report,
      status,
      exitCode,
      projectRoot,
      outputDir: output,
      reportPath: layout.report,
      artifactsRoot: layout.results,
      aiTracePath: undefined,
      traces,
      redact: redactError,
    }, {
      processOutput: terminal,
      timeoutMs: 30_000,
      force: new AbortController().signal,
    });
    process.stderr.write(`Merged ${inputs.length} shard reports: ${status} (${summary.selected} selected, ${summary.failed} failed)\n`);
    return exitCode;
  } catch (cause) {
    process.stderr.write(`e2e merge-reports: ${redactError(errorMessage(cause))}\n`);
    return 2;
  } finally {
    terminal.end();
  }
}
