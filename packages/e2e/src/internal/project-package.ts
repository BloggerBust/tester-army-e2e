/** What a project says about a package: the spec its package.json declares. */

import path from 'node:path';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';
import { detectWorkspacePackageManager, readPackageManifest, type PackageManager } from './package-manager.ts';

/** The runner's package name. */
export const RUNNER = 'e2e';

/** The sections a package manager installs a project's packages from. */
export const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

interface Declaration {
  /** The directory of the package.json that lists the package. */
  readonly dir: string;
  readonly manager: PackageManager;
  /** The spec the manager installs from, or undefined when sections disagree and the manager's choice depends on its version. */
  readonly spec: string | undefined;
}

/** The spec each section of `manifest` gives `name`. */
function sectionSpecs(manifest: Record<string, unknown>, name: string): Record<(typeof DEPENDENCY_SECTIONS)[number], string | undefined> {
  const spec = (section: (typeof DEPENDENCY_SECTIONS)[number]): string | undefined => {
    const dependencies = manifest[section];
    const value = isPlainObject(dependencies) ? dependencies[name] : undefined;
    return typeof value === 'string' ? value.trim() : undefined;
  };
  return { dependencies: spec('dependencies'), devDependencies: spec('devDependencies'), optionalDependencies: spec('optionalDependencies') };
}

/**
 * The spec `manager` installs from when sections give different ones. Every
 * manager takes `optionalDependencies` over `dependencies`. Against
 * `devDependencies`, npm and Yarn 2 and later take the dev spec, and pnpm
 * and Yarn 1 the other. Bun takes the optional spec over the dev one and the
 * dev one over `dependencies`, and its choice among all three changed
 * between releases. Measured on npm 8 to 11, pnpm 9 to 12, Yarn 1, 3, and 4,
 * and Bun 1.1 to 1.4.
 */
function installedSpec(specs: ReturnType<typeof sectionSpecs>, manager: PackageManager): string | undefined {
  const { dependencies, devDependencies, optionalDependencies } = specs;
  const production = optionalDependencies ?? dependencies;
  if (production === undefined || devDependencies === undefined || production === devDependencies) return production ?? devDependencies;
  switch (manager) {
    case 'npm':
      return devDependencies;
    case 'pnpm':
      return production;
    case 'bun':
      if (optionalDependencies === undefined) return devDependencies;
      return dependencies === undefined ? optionalDependencies : undefined;
    case 'yarn':
      return undefined;
  }
}

/** The nearest package.json from `cwd` up that lists `name`, its package manager, and the spec that manager installs from. */
export function declaringPackage(cwd: string, name: string, env: NodeJS.ProcessEnv = process.env): Declaration | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifest = readPackageManifest(dir);
    const specs = manifest === undefined ? undefined : sectionSpecs(manifest, name);
    if (specs !== undefined && Object.values(specs).some((spec) => spec !== undefined)) {
      const { manager } = detectWorkspacePackageManager(dir, env);
      return { dir, manager, spec: installedSpec(specs, manager) };
    }
    if (path.dirname(dir) === dir) return undefined;
  }
}
