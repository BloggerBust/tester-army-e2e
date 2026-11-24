/** First-run browser provisioning for the Playwright engine. */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { EngineError, InfrastructureError, type EngineDoctorCheck } from '@e2e-dev/core/engine';
import { browserType, type BrowserName } from './browser-connection.ts';
import { missingHostLibraries, missingLibrariesMessage, type HostLibraryProbe } from './host-libraries.ts';

/** The executable of `chromium_headless_shell-<revision>` under `browsersPath`, once it finished installing. */
function headlessShellExecutable(browsersPath: string, revision: string): string | undefined {
  const shellRoot = path.join(browsersPath, `chromium_headless_shell-${revision}`);
  if (!existsSync(path.join(shellRoot, 'INSTALLATION_COMPLETE'))) return undefined;
  const executable = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
  return readdirSync(shellRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(shellRoot, entry.name, executable))
    .find((candidate) => existsSync(candidate));
}

/**
 * The executable of the build the run launches (headless shell for headless chromium, else the
 * full build), false when it is not on disk, or undefined when `env` points at another cache
 * than this process loaded.
 */
async function installedExecutable(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): Promise<string | false | undefined> {
  if (env['PLAYWRIGHT_BROWSERS_PATH'] !== process.env['PLAYWRIGHT_BROWSERS_PATH']) return undefined;
  try {
    const executable = (await browserType(name)).executablePath();
    if (headed || name !== 'chromium') return existsSync(executable) && executable;
    return headlessShellBeside(executable) ?? false;
  } catch {
    return false;
  }
}

async function isBrowserInstalled(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean): Promise<boolean | undefined> {
  const executable = await installedExecutable(name, env, headed);
  return executable === undefined ? undefined : executable !== false;
}

/** The installed shell beside `executable`'s full build. */
function headlessShellBeside(executable: string): string | undefined {
  const marker = `${path.sep}chromium-`;
  const at = executable.lastIndexOf(marker);
  if (at === -1) return undefined;
  const revision = executable.slice(at + marker.length).split(path.sep)[0] ?? '';
  return revision === '' ? undefined : headlessShellExecutable(executable.slice(0, at), revision);
}

/**
 * The system libraries the installed build of `name` cannot resolve on Linux;
 * empty when the build is absent, elsewhere, or on another platform.
 */
export async function missingBrowserLibraries(name: BrowserName, env: NodeJS.ProcessEnv, headed: boolean, probe?: HostLibraryProbe): Promise<string[]> {
  const executable = await installedExecutable(name, env, headed);
  return typeof executable === 'string' ? missingHostLibraries(executable, env, probe) : [];
}

/** The `node` arguments that run the pinned `playwright-core` CLI with `args`. */
function playwrightCliArgs(args: readonly string[]): string[] {
  const require = createRequire(import.meta.url);
  return [path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js'), ...args];
}

/**
 * Runs the pinned Playwright CLI with `args`, sharing this process's terminal,
 * and resolves to its exit code, 128 plus the signal number when a signal
 * ended it. SIGINT and SIGTERM sent to this process reach the child, so a
 * cancelled CI job does not leave a download running. Backs the `e2e-web` command.
 */
export function runPlaywrightCli(args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, playwrightCliArgs(args), {
      stdio: 'inherit',
      env: installEnvironment(),
    });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const settle = () => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
    };
    child.on('error', (error) => {
      settle();
      reject(error);
    });
    child.on('exit', (code, signal) => {
      settle();
      resolve(code ?? (signal === null ? 1 : 128 + os.constants.signals[signal]));
    });
  });
}

/**
 * The `browser` check of `e2e doctor`: whether the build a run launches is on
 * disk and its system libraries resolve, a `warn` when the first run will
 * download it, a `fail` when libraries are missing, or none when `env` points
 * at another browser cache than this process loaded.
 */
export async function browserCheck(
  name: BrowserName,
  env: NodeJS.ProcessEnv,
  headed: boolean,
  isInstalled: (name: BrowserName) => boolean | undefined | Promise<boolean | undefined> = (browser) => isBrowserInstalled(browser, env, headed),
  missingLibraries: (name: BrowserName) => readonly string[] | Promise<readonly string[]> = (browser) => missingBrowserLibraries(browser, env, headed),
): Promise<EngineDoctorCheck[]> {
  const installed = await isInstalled(name);
  if (installed === undefined) return [];
  if (!installed) {
    return [
      {
        id: 'browser',
        status: 'warn',
        message: `${name} is not installed; the first run downloads it, or run "npx @e2e-dev/web install ${name}" now`,
      },
    ];
  }
  const missing = await missingLibraries(name);
  if (missing.length > 0) return [{ id: 'browser', status: 'fail', message: missingLibrariesMessage(name, missing) }];
  return [{ id: 'browser', status: 'pass', message: `${name} is installed` }];
}

/** What an installer receives besides the browser names. */
export interface InstallContext {
  /** Receives every line the installer prints: the download URL, progress, warnings. */
  readonly log: (line: string) => void;
  /** Aborts a download in progress. */
  readonly signal?: AbortSignal | undefined;
  /** Environment the installer runs with: the run's, so it fills the cache the workers will launch from. */
  readonly env: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. */
  readonly headed: boolean;
}

export interface EnsureBrowsersOptions {
  /**
   * Receives progress lines; defaults to stderr. The engine's `prepare` hands
   * the harness's `info.log` here, so a first-run download narrates through
   * the reporter rather than underneath it.
   */
  readonly log?: (line: string) => void;
  /**
   * Injected detection for tests; defaults to an executable existence check.
   * Undefined means "cannot tell here": the installer runs and decides.
   */
  readonly isInstalled?: (name: BrowserName) => boolean | undefined | Promise<boolean | undefined>;
  /** Injected installer for tests; defaults to spawning the Playwright CLI. */
  readonly install?: (names: readonly BrowserName[], context: InstallContext) => Promise<void>;
  /** Aborts a download in progress; the run's interrupt owns it. */
  readonly signal?: AbortSignal;
  /** The run's environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Whether the run launches a window, which decides the chromium build it needs. Defaults to false. */
  readonly headed?: boolean;
}

/** The `playwright install` arguments for `names`: `--only-shell` on a headless chromium run. */
export function installArgs(names: readonly BrowserName[], headed: boolean): string[] {
  if (headed || !names.includes('chromium')) return [...names];
  return ['--only-shell', ...names];
}

/** `env` with `PLAYWRIGHT_SKIP_BROWSER_GC=1` unless already set, so an install keeps other tools' browsers. */
function installEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PLAYWRIGHT_SKIP_BROWSER_GC: env['PLAYWRIGHT_SKIP_BROWSER_GC'] ?? '1' };
}

/**
 * Ensures the given Playwright browsers are installed, downloading any
 * missing ones via `playwright-core install`. Called from the engine's `prepare`,
 * once per run before any worker starts, so a download is never charged
 * against a launch timeout and never runs once per worker. Concurrent
 * installs (two runs at once) are still safe: the Playwright CLI serializes
 * them with a registry lock.
 */
export async function ensureBrowsersInstalled(
  names: readonly BrowserName[],
  options: EnsureBrowsersOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const headed = options.headed ?? false;
  const isInstalled = options.isInstalled ?? ((name: BrowserName) => isBrowserInstalled(name, env, headed));
  const verdicts = new Map(await Promise.all([...new Set(names)].map(async (name) => [name, await isInstalled(name)] as const)));
  const missing = [...verdicts.keys()].filter((name) => verdicts.get(name) !== true);
  if (missing.length === 0) return;
  // The headline is only honest when every listed browser is known to be
  // absent; when the verdict is the CLI's, its own output tells the story
  // and says nothing when there is nothing to fetch.
  const knownMissing = missing.every((name) => verdicts.get(name) === false);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  if (knownMissing) log(`Downloading missing Playwright browsers (first run): ${missing.join(', ')}...`);
  const install = options.install ?? runPlaywrightInstall;
  await install(missing, { log, signal: options.signal, env: installEnvironment(env), headed });
  if (knownMissing) log('Browser download complete.');
}

/**
 * Forwards a child's stdout or stderr to `log` one complete line at a time.
 * The Playwright CLI redraws its progress bar with carriage returns when it
 * has a terminal; with a pipe it prints whole lines, but the splitter accepts
 * both so no partial redraw ever reaches the reporter.
 */
function forwardLines(stream: NodeJS.ReadableStream, log: (line: string) => void): void {
  let pending = '';
  const flush = (text: string) => {
    for (const line of text.split(/\r\n|\n|\r/)) {
      const trimmed = line.trimEnd();
      if (trimmed !== '') log(trimmed);
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    const cut = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
    if (cut === -1) return;
    flush(pending.slice(0, cut + 1));
    pending = pending.slice(cut + 1);
  });
  stream.on('end', () => flush(pending));
}

/** Spawns `node <playwright-core>/cli.js install <names>`, narrating its output through `log`. */
function runPlaywrightInstall(
  names: readonly BrowserName[],
  { log, signal, env, headed }: InstallContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new EngineError('CANCELLED', 'browser install cancelled', { retryable: false }));
      return;
    }
    const child = spawn(process.execPath, playwrightCliArgs(['install', ...installArgs(names, headed)]), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    forwardLines(child.stdout, log);
    forwardLines(child.stderr, log);
    const onAbort = () => {
      child.kill();
      reject(new EngineError('CANCELLED', 'browser install cancelled', { retryable: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('exit', () => signal?.removeEventListener('abort', onAbort));
    child.on('error', (cause) => {
      reject(
        new InfrastructureError('BROWSER_INSTALL_FAILED', `failed to run playwright-core install: ${cause.message}`, {
          cause,
        }),
      );
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new InfrastructureError(
          'BROWSER_INSTALL_FAILED',
          `playwright-core install ${names.join(' ')} exited with code ${String(code)}; run "npx @e2e-dev/web install ${names.join(' ')}" (pnpm: "pnpm exec e2e-web install ${names.join(' ')}") manually`,
        ),
      );
    });
  });
}
