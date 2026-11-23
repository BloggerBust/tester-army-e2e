/**
 * `e2e report`: opens the self-contained HTML report written by `@e2e-dev/html-reporter`.
 */

import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveOutputDir } from '@e2e-dev/core/lib/config/resolve';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { redactError } from '@e2e-dev/core/lib/run/secrecy';
import { discoverConfig, loadConfigModule } from '../config/load.ts';
import { platformOpenCommand, spawnBrowserCommand } from '../internal/open-browser.ts';

const REPORT_FILE = 'report.html';

export interface ReportOptions {
  /** Explicit HTML report file or directory containing `report.html`. */
  readonly path?: string;
  /** Explicit config file path; the nearest config file when absent. */
  readonly config?: string;
  /** `--output`: results directory overriding the config's `output` (and default `.e2e`). */
  readonly output?: string;
  readonly cwd?: string;
  /** Test seam: replaces the OS browser launch with an inspection callback. */
  readonly open?: (url: string) => void;
}

/**
 * Resolves the HTML report file, checks that it exists on disk, and opens it in
 * the default browser. Returns exit code `0` on success or `2` when the config
 * or report path cannot be resolved or read.
 */
export async function report(options: ReportOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  if (options.path !== undefined && options.output !== undefined) {
    process.stderr.write('pass either [path] or --output, not both\n');
    return 2;
  }

  let found: { readonly target: string; readonly filePath: string | undefined };
  try {
    found = await resolveReportFile(cwd, options);
  } catch (cause) {
    // Redacted: the config may have loaded a key and quoted it as it failed.
    process.stderr.write(`${redactError(errorMessage(cause))}\n`);
    return 2;
  }
  if (found.filePath === undefined) {
    const shown = displayPath(cwd, found.target);
    process.stderr.write(
      `no HTML report at ${shown}; pass its path to e2e report when htmlReporter({ outputFile }) writes elsewhere, or add htmlReporter() from @e2e-dev/html-reporter to reporters in e2e.config.ts and run e2e run first\n`,
    );
    return 2;
  }

  const url = pathToFileURL(found.filePath).href;
  process.stdout.write(`opening ${displayPath(cwd, found.filePath)} (${url})\n`);
  const open =
    options.open ??
    ((targetUrl: string) =>
      spawnBrowserCommand(platformOpenCommand(process.platform, targetUrl), (cause) => {
        process.stderr.write(`could not launch browser (${errorMessage(cause)}); open the URL above manually\n`);
      }));
  open(url);
  return 0;
}

async function resolveReportFile(
  cwd: string,
  options: ReportOptions,
): Promise<{ readonly target: string; readonly filePath: string | undefined }> {
  let target: string;
  if (options.path !== undefined) {
    target = path.resolve(cwd, options.path);
  } else {
    const discovered = discoverConfig(cwd, options.config);
    const rawOutput =
      discovered.configPath === undefined
        ? undefined
        : (await loadConfigModule(discovered.configPath)).output;
    target = path.join(resolveOutputDir(rawOutput, options.output, discovered.projectRoot), REPORT_FILE);
  }
  const targetStats = await statOrUndefined(target);
  if (targetStats === undefined) return { target, filePath: undefined };
  const candidate = targetStats.isDirectory() ? path.join(target, REPORT_FILE) : target;
  const fileStats = candidate === target ? targetStats : await statOrUndefined(candidate);
  if (fileStats?.isFile() !== true) return { target, filePath: undefined };
  await access(candidate, constants.R_OK);
  return { target, filePath: candidate };
}

async function statOrUndefined(target: string) {
  try {
    return await stat(target);
  } catch (cause) {
    const code = cause instanceof Error && 'code' in cause ? cause.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw cause;
  }
}

function displayPath(cwd: string, target: string): string {
  return path.relative(cwd, target) || target;
}
