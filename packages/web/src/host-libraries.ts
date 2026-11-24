/** Which shared libraries a Linux browser build needs that the host's loader cannot resolve. */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const LDD_TIMEOUT_MS = 5_000;
const LISTED_LIBRARIES = 5;

/** How the probe runs; a run uses this process's platform and the host's `ldd`, and tests inject the rest. */
export interface HostLibraryProbe {
  readonly platform?: NodeJS.Platform;
  /** Kills the `ldd` runs when it aborts; they then report nothing. */
  readonly signal?: AbortSignal;
  /** How long one `ldd` run may take before it is killed. */
  readonly timeoutMs?: number;
  /** Resolves to `ldd <file>`'s stdout, or undefined when `ldd` is absent or cannot read the file. */
  readonly ldd?: (file: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

/**
 * `ldd <file>`'s stdout, or undefined when it failed, ran past `timeoutMs`, or `signal` aborted.
 * `ldd` is a shell script that runs the loader as its child, so it gets a
 * process group of its own and a kill takes the group: killing the script
 * alone would leave the loader running.
 */
function runLdd(file: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal | undefined): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('ldd', [file], { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let listing = '';
    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group already exited.
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    const settle = (output: string | undefined): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(output);
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      listing += chunk;
    });
    child.once('error', () => settle(undefined));
    child.once('close', (code) => settle(code === 0 ? listing : undefined));
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted === true) kill();
  });
}

/** The library names an `ldd` listing marks `not found`. */
function unresolvedLibraries(lddOutput: string): string[] {
  return lddOutput
    .split('\n')
    .map((line) => /^\s*(\S+) => not found\s*$/.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

/**
 * The shared libraries `executable` and the libraries shipped beside it link
 * against that the loader cannot resolve, in the order `ldd` reports them.
 * Empty off Linux, and when `ldd` is absent or the executable is a wrapper
 * script (webkit), where nothing can be told.
 */
export async function missingHostLibraries(executable: string, env: NodeJS.ProcessEnv, probe: HostLibraryProbe = {}): Promise<string[]> {
  if ((probe.platform ?? process.platform) !== 'linux') return [];
  const directory = path.dirname(executable);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const bundled = entries.filter((entry) => entry.isFile() && /\.so(\.|$)/.test(entry.name)).map((entry) => path.join(directory, entry.name));
  // A bundled library links against its siblings, which the browser loads from its own directory.
  // The loader expands `$ORIGIN` to that directory; its literal path would split at a `:` in it.
  const searchPath = [env['LD_LIBRARY_PATH'], '$ORIGIN'].filter((part) => part !== undefined && part !== '').join(':');
  const ldd = probe.ldd ?? ((file: string, lddEnv: NodeJS.ProcessEnv) => runLdd(file, lddEnv, probe.timeoutMs ?? LDD_TIMEOUT_MS, probe.signal));
  const listings = await Promise.all([...new Set([executable, ...bundled])].map((file) => ldd(file, { ...env, LD_LIBRARY_PATH: searchPath })));
  return [...new Set(listings.flatMap((listing) => (listing === undefined ? [] : unresolvedLibraries(listing))))];
}

/** Why `name` cannot launch with `missing` unresolved, naming the first few and the install that adds them. */
export function missingLibrariesMessage(name: string, missing: readonly string[]): string {
  const listed = missing.slice(0, LISTED_LIBRARIES).join(', ');
  const rest = missing.length > LISTED_LIBRARIES ? ` and ${String(missing.length - LISTED_LIBRARIES)} more` : '';
  const count = missing.length === 1 ? 'a system library is' : `${String(missing.length)} system libraries are`;
  return `${name} cannot launch: ${count} missing (${listed}${rest}); run "npx @e2e-dev/web install ${name} --with-deps" (pnpm: "pnpm exec e2e-web install ${name} --with-deps")`;
}
