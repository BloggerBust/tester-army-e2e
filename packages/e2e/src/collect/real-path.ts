/** Symlink-free paths, for comparing the files stack frames name. */

import { realpathSync } from 'node:fs';

/** What `realPath` resolved each path to: every test of a file asks about the same few. */
const realPaths = new Map<string, string>();

/** The path with symlinks resolved, or the path itself when it cannot be resolved. */
export function realPath(file: string): string {
  const known = realPaths.get(file);
  if (known !== undefined) return known;
  try {
    const real = realpathSync.native(file);
    realPaths.set(file, real);
    return real;
  } catch {
    return file;
  }
}
