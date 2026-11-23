/**
 * Where the agent-desktop executable comes from: the `binary` option, or the
 * pinned release the engine downloads once per machine and checks against
 * its SHA-256 digest. The npm package `agent-desktop` is not a dependency:
 * its `postinstall` script would run in every install of this package.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ConfigurationError, InfrastructureError } from '@e2e-dev/core/engine';

/** The agent-desktop release this engine is written and tested against. */
export const AGENT_DESKTOP_VERSION = '1.3.1';

/** SHA-256 of each release archive, by Rust target triple, from the release's `checksums.txt`. */
const ARCHIVE_DIGESTS: Readonly<Record<string, string>> = {
  'aarch64-apple-darwin': '9b7b7cfc74892eab46c2c85d6cb7dc4863bf8dab0a222cfcfb8ae4604c69c86c',
  'x86_64-apple-darwin': '469da10cfb68928c58caff88b92b30526e0ca895ac06bc86b7f533b1d9b309b3',
  'aarch64-pc-windows-msvc': '805f1f61890f9983fceaf38cda94a37a049c379435d65607db5cedd22c8ef97b',
  'x86_64-pc-windows-msvc': '6ee4b1e078f4e78792e79f16e32e4a78b9919464aa3c55629b7e27ed53a08c13',
  'aarch64-unknown-linux-gnu': '438990a703fbeb19775596c341c3701435e80adbfa1b2f64b82ff17567d5573b',
  'x86_64-unknown-linux-gnu': 'ca77b6b75034eeb12e537dd8c0a4f2a3424119253f38b7e6bd79ba0d2fef1264',
};

const execFileAsync = promisify(execFile);

/** The release target for this machine; undefined on an OS or architecture agent-desktop ships no build for. */
function releaseTarget(): string | undefined {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
  if (arch === undefined) return undefined;
  switch (process.platform) {
    case 'darwin':
      return `${arch}-apple-darwin`;
    case 'win32':
      return `${arch}-pc-windows-msvc`;
    case 'linux':
      return `${arch}-unknown-linux-gnu`;
    default:
      return undefined;
  }
}

/** The executable's file name on this OS. */
function executableName(): string {
  return process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop';
}

/** The file an unpacked release is stamped with once its archive's digest checked out: the digest itself. */
const STAMP = '.verified';

/** Whether `file` is a regular file this process may run: a directory passes the execute check on macOS, being searchable, but cannot be run. */
async function executableFile(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the cache entry is a whole, checked release: stamped with the
 * pinned digest, its executable still executable, and on macOS the helper
 * beside it. An entry that is not (cut short, its execute bit lost, the
 * helper deleted) is downloaded again.
 */
async function usable(directory: string, digest: string): Promise<boolean> {
  try {
    if ((await readFile(path.join(directory, STAMP), 'utf8')).trim() !== digest) return false;
    if (!(await executableFile(path.join(directory, executableName())))) return false;
    if (process.platform === 'darwin' && !(await executableFile(path.join(directory, 'agent-desktop-macos-helper')))) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * The per-user cache the pinned release unpacks into, under the OS's cache
 * directory: `~/Library/Caches/e2e` on macOS, `%LOCALAPPDATA%\\e2e\\cache` on
 * Windows, `$XDG_CACHE_HOME/e2e` (or `~/.cache/e2e`) on Linux. Read from the
 * run's environment, never `process.env`, so `prepare` and the workers agree.
 */
function cacheDirectory(env: Readonly<Record<string, string | undefined>>, target: string): string {
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) ?? homedir();
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'e2e')
      : process.platform === 'win32'
        ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'e2e', 'cache')
        : path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), 'e2e');
  return path.join(base, 'agent-desktop', `${AGENT_DESKTOP_VERSION}-${target}`);
}

/** Whether the pinned release is in the cache whole and checked, as `prepare` leaves it and a worker needs it. */
export async function pinnedInstalled(env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const target = releaseTarget();
  const digest = target === undefined ? undefined : ARCHIVE_DIGESTS[target];
  return target !== undefined && digest !== undefined && (await usable(cacheDirectory(env, target), digest));
}

/** Where the executable is, or would be once `prepare` downloads it; undefined when nothing can be run here. */
export function pinnedExecutable(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const target = releaseTarget();
  return target === undefined ? undefined : path.join(cacheDirectory(env, target), executableName());
}

/**
 * The executable a worker runs: the `binary` option resolved against the
 * project, else the pinned release. Throws when neither exists, which means
 * `prepare` did not run (a programmatic host that skips it) or failed.
 */
export async function resolveExecutable(binary: string | undefined, projectRoot: string, env: Readonly<Record<string, string | undefined>>): Promise<string> {
  if (binary !== undefined) {
    const resolved = path.resolve(projectRoot, binary);
    if (!(await executableFile(resolved))) throw new ConfigurationError('INVALID_CONFIG', `desktop({ binary }) names ${resolved}, which is not an executable file`);
    return resolved;
  }
  const target = releaseTarget();
  const digest = target === undefined ? undefined : ARCHIVE_DIGESTS[target];
  if (target === undefined || digest === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `agent-desktop has no release for ${process.platform} on ${process.arch}; pass desktop({ binary }) to use a build of your own`);
  }
  const directory = cacheDirectory(env, target);
  if (!(await usable(directory, digest))) {
    throw new InfrastructureError('AGENT_DESKTOP_INSTALL_FAILED', `agent-desktop ${AGENT_DESKTOP_VERSION} is not installed whole at ${directory}; the engine's prepare step downloads it before the first test`);
  }
  return path.join(directory, executableName());
}

/**
 * Downloads and unpacks the pinned release unless a whole, checked copy is
 * already in the cache; a damaged one is replaced. Any failure but a
 * cancellation is `AGENT_DESKTOP_INSTALL_FAILED`. `digests` is the pinned
 * table, which only a test replaces, to unpack an archive of its own.
 */
export async function installPinned(env: Readonly<Record<string, string | undefined>>, signal: AbortSignal, log: (line: string) => void, digests: Readonly<Record<string, string>> = ARCHIVE_DIGESTS): Promise<string> {
  const target = releaseTarget();
  const digest = target === undefined ? undefined : digests[target];
  if (target === undefined || digest === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `agent-desktop has no release for ${process.platform} on ${process.arch}; pass desktop({ binary }) to use a build of your own`);
  }
  const directory = cacheDirectory(env, target);
  const executable = path.join(directory, executableName());
  await sweepLeftovers(directory);
  if (await usable(directory, digest)) return executable;
  const archive = `agent-desktop-v${AGENT_DESKTOP_VERSION}-${target}.tar.gz`;
  const url = `https://github.com/vercel-labs/agent-desktop/releases/download/v${AGENT_DESKTOP_VERSION}/${archive}`;
  log(`downloading agent-desktop ${AGENT_DESKTOP_VERSION} (${target})`);
  try {
    await download(url, archive, digest, directory, signal);
  } catch (cause) {
    if (cause instanceof InfrastructureError || signal.aborted) throw cause;
    throw new InfrastructureError('AGENT_DESKTOP_INSTALL_FAILED', `installing agent-desktop from ${url} failed: ${(cause as Error).message}`, { cause });
  }
  return executable;
}

/**
 * Fetches the archive, checks its digest before anything is unpacked, and
 * unpacks it by the OS's `tar` into a fresh directory that becomes the cache
 * entry in one rename, so a download cut short never leaves a half-written
 * executable behind.
 */
async function download(url: string, archive: string, digest: string, directory: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new InfrastructureError('AGENT_DESKTOP_INSTALL_FAILED', `downloading ${url} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) {
    throw new InfrastructureError('AGENT_DESKTOP_INSTALL_FAILED', `${archive} has SHA-256 ${actual}, expected ${digest}; refusing to unpack it`);
  }
  await mkdir(path.dirname(directory), { recursive: true });
  const staging = await mkdtemp(`${directory}.partial-`);
  try {
    const file = path.join(staging, archive);
    await writeFile(file, bytes);
    await execFileAsync('tar', ['-xzf', file, '-C', staging], { signal });
    await rm(file);
    if (process.platform !== 'win32') await chmod(path.join(staging, executableName()), 0o755);
    // Written last, so only a whole, checked unpack is ever stamped.
    await writeFile(path.join(staging, STAMP), digest);
    await publish(staging, directory, digest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** How old an unpack or a moved-aside entry must be before a later install removes it: no install still running is using one that old. */
const LEFTOVER_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the unpacks (`.partial-*`) and moved-aside entries (`.stale-*`)
 * beside the cache entry that an install killed mid-way left behind, each
 * a whole copy of agent-desktop. Only ones a day old go: an install running
 * now may still be using a newer one. Best effort; a failure leaves them.
 */
async function sweepLeftovers(directory: string): Promise<void> {
  const parent = path.dirname(directory);
  const base = path.basename(directory);
  for (const entry of await readdir(parent).catch(() => [] as string[])) {
    if (!entry.startsWith(`${base}.partial-`) && !entry.startsWith(`${base}.stale-`)) continue;
    const leftover = path.join(parent, entry);
    const old = await stat(leftover).then((info) => Date.now() - info.mtimeMs > LEFTOVER_AGE_MS, () => false);
    if (old) await rm(leftover, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** How many times a publish looks again after another run changed the cache entry under it. */
const PUBLISH_TRIES = 10;

/**
 * Puts a checked unpack in place as the cache entry, with no lock: every
 * run that installs at the same time publishes a copy of the same checked
 * release, so whichever copy is in place, checked, is the winner and the
 * others are dropped. A rename onto an existing entry fails, so an entry is
 * replaced only once it was seen damaged and moved aside; one that turns out
 * whole once moved (another run put it there meanwhile) goes back.
 */
async function publish(staging: string, directory: string, digest: string): Promise<void> {
  // Why the last rename into place failed: an entry another run put there, or something else (permissions, a full disk), which the error names.
  let failure: NodeJS.ErrnoException | undefined;
  for (let tries = 0; tries < PUBLISH_TRIES; tries += 1) {
    if (await rename(staging, directory).then(() => true, (cause: unknown) => ((failure = cause as NodeJS.ErrnoException), false))) return;
    if (await usable(directory, digest)) return;
    // A damaged entry is moved aside, not deleted first, so the executable is missing only between two renames. Of two runs that move it, one fails and looks again.
    const aside = `${directory}.stale-${process.pid}-${randomUUID()}`;
    if (!(await rename(directory, aside).then(() => true, () => false))) continue;
    if (await usable(aside, digest)) await rename(aside, directory).catch(() => undefined);
    await rm(aside, { recursive: true, force: true });
  }
  if (await usable(directory, digest)) return;
  const raced = failure === undefined || failure.code === 'EEXIST' || failure.code === 'ENOTEMPTY';
  throw new InfrastructureError('AGENT_DESKTOP_INSTALL_FAILED', `could not put agent-desktop in place at ${directory}: ${raced ? 'other runs kept changing it' : failure?.message}`, failure === undefined ? {} : { cause: failure });
}
