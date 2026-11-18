/**
 * The sessions a run holds open, one marker file per session under the
 * system temp directory. Notte sessions carry no tags to find a run's by, but
 * the runner and its workers share one machine: a worker writes a marker when
 * it starts a session and removes it once the session is stopped, so the
 * markers left at the end of the run name the sessions of workers that died.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A session id as a file name: what Notte issues, never anything that could leave the run's directory. */
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

/** The run's markers for one target: a path built from ids, never trusted as one. */
function dirFor(runId: string, targetName: string): string {
  const run = runId.replace(/[^A-Za-z0-9_-]/g, '_');
  const target = createHash('sha256').update(targetName).digest('hex').slice(0, 16);
  return path.join(tmpdir(), 'e2e-notte', run, target);
}

/** The marker of one session; an id Notte would not issue is refused rather than written. */
function markerFor(runId: string, targetName: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not one Notte issues`);
  return path.join(dirFor(runId, targetName), sessionId);
}

/** Whether a filesystem error says the path does not exist. */
function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/**
 * Records that the run started `sessionId` for `targetName`, before the
 * session is handed to the engine. Rejects when the marker cannot be written,
 * so the caller stops the session rather than run one the sweep cannot find.
 */
export async function remember(runId: string, targetName: string, sessionId: string): Promise<void> {
  const marker = markerFor(runId, targetName, sessionId);
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, '', { mode: 0o600 });
}

/** Records that `sessionId` was stopped; called only after Notte confirmed it. */
export async function forget(runId: string, targetName: string, sessionId: string): Promise<void> {
  await rm(markerFor(runId, targetName, sessionId), { force: true });
}

/** The sessions the run started for `targetName` and never recorded as stopped. Rejects on any read error but a missing directory. */
export async function remembered(runId: string, targetName: string): Promise<string[]> {
  const entries = await readdir(dirFor(runId, targetName), { withFileTypes: true }).catch((cause: unknown) => {
    if (isMissing(cause)) return [];
    throw cause;
  });
  return entries.flatMap((entry) => (entry.isFile() && SESSION_ID.test(entry.name) ? [entry.name] : []));
}

/** Removes the target's directory and then the run's, each only once empty, so a marker kept for a failed stop survives. */
export async function prune(runId: string, targetName: string): Promise<void> {
  const dir = dirFor(runId, targetName);
  for (const empty of [dir, path.dirname(dir)]) {
    await rmdir(empty).catch((cause: unknown) => {
      if (isMissing(cause) || (cause instanceof Error && 'code' in cause && (cause.code === 'ENOTEMPTY' || cause.code === 'EEXIST'))) return;
      throw cause;
    });
  }
}
