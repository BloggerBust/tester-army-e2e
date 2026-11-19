/** Atomic report persistence. */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '@e2e-dev/core/lib/internal/atomic-write';

/** Atomically writes one text document, creating the parent directory when it is missing. */
export async function writeTextReport(filePath: string, content: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, content);
}

/** Atomically writes a wire JSON document with two-space indent and trailing newline. */
export async function writeJsonReport(filePath: string, document: unknown): Promise<void> {
  await writeTextReport(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

/** A path as the report keeps them: POSIX separators whatever the host. */
export function toPosixPath(relative: string): string {
  return relative.split(path.sep).join(path.posix.sep);
}

/** `to` relative to `from` with POSIX separators, `.` when they are the same directory. */
export function posixRelative(from: string, to: string): string {
  return toPosixPath(path.relative(from, to)) || '.';
}
