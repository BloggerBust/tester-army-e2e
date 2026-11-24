/** The packages an existing config imports, for a re-run of `e2e init` to add the ones package.json lacks. */

import path from 'node:path';
import { packageVersion } from '@e2e-dev/core/lib/internal/package-version';
import { aliasedFile } from '../../config/esm-hooks.ts';
import { oxc } from '../../config/typescript.ts';
import { installedPackage } from '../../internal/installed-package.ts';
import { execCommand, type PackageManager } from '../../internal/package-manager.ts';
import { parseVersion, specAccepts } from '../../internal/semver.ts';
import { getEnginePresets } from './engines.ts';
import { AI_DEPENDENCIES, GATEWAYS } from './gateways.ts';
import { declaredSpec, type PackageManifest } from './package.ts';
import { siblingDependency } from './versions.ts';

const RUNNER_VERSION = packageVersion(import.meta.url, '../../../package.json', '0.0.0');

/** A string literal with no escapes or interpolation, as a dynamic `import()` argument. */
const PLAIN_STRING = /^(['"`])([^'"`\\$]+)\1$/u;

/** A bare specifier's package name: one segment, or two under a scope. */
const PACKAGE_NAME = /^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/|$)/u;

/**
 * Every module specifier `source` imports, re-exports from, or loads with a
 * literal `import()`, read from the parsed module so an import in a comment
 * or a string counts for nothing. Throws for a file that does not parse,
 * whose module record is partial, and `TYPESCRIPT_COMPILER_UNAVAILABLE` when
 * oxc cannot load.
 */
function importedSpecifiers(file: string, source: string): string[] {
  const { errors, module } = oxc().parser.parseSync(file, source);
  const error = errors.find(({ severity }) => severity === 'Error');
  if (error !== undefined) throw new Error(`syntax error: ${error.message}`);
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((statement) => statement.entries.map((entry) => entry.moduleRequest?.value)),
    ...module.dynamicImports.map(({ moduleRequest }) => PLAIN_STRING.exec(source.slice(moduleRequest.start, moduleRequest.end))?.[2]),
  ].filter((specifier) => specifier !== undefined);
}

/**
 * The dependencies of the config at `configPath` that init has a range for,
 * from its import specifiers: the engines with `@e2e-dev/core`, `ai` with
 * `zod`, and each gateway's provider packages. A gateway counts when the
 * config imports the module its preset imports, such as
 * `e2e/oauth/chatgpt`, and brings the provider packages that module loads.
 * A specifier the project's tsconfig.json maps to a file is that file, as it
 * is for the loader, and any other package is the project's own to declare.
 */
function importedDependencies(configPath: string, source: string): Readonly<Record<string, string>> {
  const specifiers = new Set(importedSpecifiers(configPath, source).filter((specifier) => aliasedFile(specifier, configPath) === undefined));
  const packages = new Set([...specifiers].flatMap((specifier) => PACKAGE_NAME.exec(specifier)?.[1] ?? []));
  const engines = new Map(getEnginePresets().flatMap((preset) => Object.entries(preset.dependencies)));
  const providers = new Map(GATEWAYS.flatMap((gateway) => Object.entries(gateway.dependencies)));
  const core = siblingDependency('@e2e-dev/core');

  const needed: Record<string, string> = {};
  for (const name of packages) {
    const range = engines.get(name) ?? providers.get(name);
    if (range !== undefined) needed[name] = range;
  }
  // Every engine peers on `@e2e-dev/core`, as in a new scaffold.
  if ([...engines.keys()].some((name) => packages.has(name))) Object.assign(needed, core);
  const gateways = GATEWAYS.filter((gateway) => specifiers.has(/from '([^']+)'/u.exec(gateway.import)?.[1] ?? ''));
  for (const gateway of gateways) Object.assign(needed, gateway.dependencies);
  // A provider peers on `ai`, and both on zod. zod alone is the project's own schema library.
  if (gateways.length > 0 || packages.has('ai') || [...providers.keys()].some((name) => packages.has(name))) {
    Object.assign(needed, AI_DEPENDENCIES);
  }
  return needed;
}

/**
 * Whether this CLI is the `e2e` the project installs, so that the ranges it
 * writes, each for a package released alongside it, fit that `e2e`. A spec
 * this cannot compare, such as a workspace link or a dist-tag, is answered
 * by the copy under node_modules.
 */
function isProjectRunner(cwd: string, declared: string): boolean {
  const running = parseVersion(RUNNER_VERSION);
  const satisfied = running === undefined ? undefined : specAccepts(declared, running);
  return satisfied ?? installedPackage(cwd, 'e2e')?.version === RUNNER_VERSION;
}

/**
 * What a re-run adds for the existing config `config` in `cwd`: the
 * packages it imports that `manifest` lacks, or none, with the reason, when
 * its imports cannot be read or the project is on another `e2e` than this
 * one. Ranges from this CLI beside an older pinned `e2e` fail the install on
 * the added packages' peer ranges.
 */
export function missingConfigDependencies(input: {
  readonly cwd: string;
  readonly config: string;
  readonly source: string;
  readonly manifest: PackageManifest;
  readonly manager: PackageManager;
}): { readonly dependencies: Readonly<Record<string, string>>; readonly warning?: string } {
  const { cwd, config, manifest, manager } = input;
  let imported: Readonly<Record<string, string>>;
  try {
    imported = importedDependencies(path.join(cwd, config), input.source);
  } catch (cause) {
    return {
      dependencies: {},
      warning: `Could not read the imports of ${config}, so its packages were not checked against package.json: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const missing = Object.entries(imported).filter(([name]) => declaredSpec(manifest, name) === undefined);
  const declared = declaredSpec(manifest, 'e2e');
  if (missing.length === 0 || declared === undefined || isProjectRunner(cwd, declared)) return { dependencies: Object.fromEntries(missing) };
  return {
    dependencies: {},
    warning: `${config} imports ${missing.map(([name]) => name).join(', ')}, which package.json lacks. Not added: package.json has e2e@${declared} and this is e2e ${RUNNER_VERSION}, whose ranges for them may not fit it. Run ${manager} install, then ${execCommand(manager, 'e2e init')}, for the project's own e2e to add them, or add them at versions that fit it.`,
  };
}
