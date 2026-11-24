import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The nearest `node_modules/<name>` from `dir` up whose package.json names a version, or undefined (not installed, or Plug'n'Play). */
export function installedPackage(dir: string, name: string): { dir: string; version: string } | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const packageDir = path.join(current, 'node_modules', name);
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
      const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest ? manifest.version : undefined;
      if (typeof version === 'string') return { dir: packageDir, version };
    } catch {
      // Not here; a workspace hoists to a parent.
    }
    if (path.dirname(current) === current) return undefined;
  }
}
