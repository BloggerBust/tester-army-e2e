/**
 * `e2e upgrade` (alias `update`): moves the project's `e2e` to the latest
 * release, a dist-tag, or one version, and every `@e2e-dev/*` package the
 * project declares along with it, each to the newest release whose peer
 * ranges accept the new versions. An `@e2e-dev/*` package those releases peer
 * on and the project does not declare is added beside the one that needs it.
 * The new specs go into package.json, each in the section it was in, and one
 * install with the project's package manager resolves them, so its lockfile
 * and its workspace stay its own.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import picocolors from 'picocolors';
import { z } from 'zod';
import { installedPackage } from '../internal/installed-package.ts';
import { detectWorkspacePackageManager, execCommand, installCommand, LOCKFILE_NAMES, type PackageManager } from '../internal/package-manager.ts';
import { isCiMode } from '@e2e-dev/core/lib/config/resolve';
import { insideProjectRoot, realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { DEPENDENCY_SECTIONS, RUNNER } from '../internal/project-package.ts';
import { compareVersions, parseVersion, satisfies } from '../internal/semver.ts';
import type { UpgradeOutcome, UpgradeResult } from '../telemetry/events.ts';
import {
  describeCopy,
  describeDuplicate,
  describeLinks,
  describeObstacles,
  findDuplicateSkills,
  findInstalledSkillDirs,
  findPackageSkillLinks,
  linkedAtSkillName,
  planSkillInstall,
  writeSkillCopy,
} from './init/agent-skill.ts';
import { describeManifestError, readPackage, serializePackage } from './init/package.ts';
import { packagedSkillDirectory, readSkillFiles, SKILL_NAME } from './skill.ts';
import type { UpgradeTarget } from './upgrade-target.ts';
import { upgradeCelebration } from './star.ts';

export interface UpgradeOptions {
  readonly target: UpgradeTarget;
  /** Print the plan and the install command, and change nothing. */
  readonly dryRun?: boolean;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  /** Runs the install command; the CLI hands it to the terminal. */
  readonly spawn?: (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => SpawnOutcome;
}

interface SpawnOutcome {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error | undefined;
}

const SCOPE = '@e2e-dev/';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const RELEASES_URL = 'https://github.com/e2e-inc/e2e/releases/tag/';
/** Each metadata request gets this long; a person waits on it. */
const REGISTRY_TIMEOUT_MS = 15_000;
const SECTIONS = DEPENDENCY_SECTIONS;
type Section = (typeof SECTIONS)[number];
/** Specs that do not name a registry version: a workspace, a path, a git or tarball URL, an alias, a pnpm catalog. */
const NON_REGISTRY_SPEC = /^(?:workspace|link|file|portal|patch|catalog|npm|git|git\+[a-z]+|github|gitlab|bitbucket|https?):|[/\\]/u;

const packumentSchema = z.looseObject({
  'dist-tags': z.record(z.string(), z.string()).default({}),
  versions: z.record(
    z.string(),
    z.looseObject({
      dependencies: z.record(z.string(), z.string()).optional(),
      peerDependencies: z.record(z.string(), z.string()).optional(),
      peerDependenciesMeta: z.record(z.string(), z.looseObject({ optional: z.boolean().optional() })).optional(),
      deprecated: z.string().optional(),
    }),
  ),
});
type Packument = z.infer<typeof packumentSchema>;

/** A package the project declares and the command moves. */
interface Declared {
  readonly name: string;
  readonly section: Section;
  /** The spec in package.json, such as `^0.20.0`. */
  readonly spec: string;
  /** The version installed under node_modules, when one is. */
  readonly installed: string | undefined;
}

interface Planned extends Declared {
  readonly version: string;
  /** The spec written to package.json: the version, with the range operator the old spec had. */
  readonly request: string;
  /** The declared package whose peer this is, for one the project did not declare and the upgrade adds. */
  readonly peerOf?: string;
}

/** A failure that ends the command: what to print, how telemetry names it, and the exit code. */
class UpgradeError extends Error {
  constructor(
    message: string,
    readonly result: UpgradeResult,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** The outcome's facts, filled in as the command learns them. */
type UpgradeFacts = { -readonly [Key in keyof Omit<UpgradeOutcome, 'result'>]: UpgradeOutcome[Key] };

/**
 * Runs `e2e upgrade` and returns how it ended, for telemetry, with the exit
 * code: 0 when the packages were installed, were already at the target, or
 * `--dry-run` printed the plan; 2 for a project, version, or tag the command
 * cannot act on and for a failed installation; 3 when the registry did not
 * answer; 130 when the installation was interrupted.
 */
export async function upgrade(options: UpgradeOptions): Promise<UpgradeOutcome & { readonly exitCode: number }> {
  const facts: UpgradeFacts = {
    target: options.target.kind === 'version' ? { kind: 'version' } : { kind: 'tag', tag: options.target.tag },
    fromVersion: null,
    toVersion: null,
    manager: null,
    siblings: [],
    moved: 0,
    linked: 0,
  };
  try {
    // Awaited first: the command fills `facts` in as it goes.
    const ended = await upgradeOrThrow(options, facts);
    return { ...facts, ...ended };
  } catch (cause) {
    if (!(cause instanceof UpgradeError)) throw cause;
    process.stderr.write(`e2e upgrade: ${cause.message}\n`);
    return { ...facts, result: cause.result, exitCode: cause.exitCode };
  }
}

async function upgradeOrThrow(options: UpgradeOptions, facts: UpgradeFacts): Promise<{ result: UpgradeResult; exitCode: number }> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const out = (text: string): void => void process.stdout.write(`${text}\n`);
  const project = findProject(cwd);
  const { declared, linked } = declaredPackages(project.dir, project.manifest);
  facts.linked = linked.length;
  const runner = declared.find((entry) => entry.name === RUNNER);
  if (runner === undefined) {
    const spec = linked.find((entry) => entry.name === RUNNER)?.spec;
    throw new UpgradeError(
      `e2e is "${spec}" in ${relative(cwd, project.manifestPath)}, not a registry version; change that spec yourself`,
      'linked',
      2,
    );
  }
  facts.fromVersion = runner.installed ?? null;
  for (const entry of linked) out(picocolors.dim(`Skipping ${entry.name}: "${entry.spec}" is not a registry version`));

  const registry = registryUrl(env);
  const fetchImpl = options.fetch ?? fetch;
  const packuments = new Map(
    await Promise.all(declared.map(async (entry) => [entry.name, await fetchPackument(registry, entry.name, fetchImpl)] as const)),
  );
  const target = resolveRunner(options.target, packuments.get(RUNNER));
  facts.toVersion = target;
  const versions = resolveSiblings(options.target, target, declared, packuments, (name) => out(picocolors.dim(`Skipping ${name}: the registry has no such package`)));
  const listed = declared.flatMap((entry): Planned[] => {
    const version = versions.get(entry.name);
    return version === undefined ? [] : [{ ...entry, version, request: requestFor(entry.spec, version, options.target) }];
  });
  const known = new Set([...declared, ...linked].map((entry) => entry.name));
  const plan = [...listed, ...(await undeclaredPeers(options.target, listed, known, packuments, (name) => fetchPackument(registry, name, fetchImpl)))];
  facts.siblings = plan.filter((entry) => entry.name !== RUNNER).map((entry) => entry.name);

  const { manager, root } = detectWorkspacePackageManager(project.dir, env);
  facts.manager = manager;
  const where = path.resolve(project.dir) === path.resolve(cwd) ? '' : ` in ${relative(cwd, project.dir)}`;
  const changing = plan.filter(moves);
  if (changing.length === 0) {
    out(`Already up to date${where}: ${plan.map((entry) => `${entry.name} ${entry.version}`).join(', ')}`);
    // A package manager may have moved e2e without this command; its skill copies still follow.
    refreshSkills(project.dir, manager, out, options.dryRun === true);
    return { result: 'up-to-date', exitCode: 0 };
  }
  out(`${options.dryRun === true ? 'Would upgrade' : 'Upgrading'}${where} with ${manager}:`);
  const width = Math.max(...plan.map((entry) => entry.name.length));
  for (const entry of plan) out(`  ${entry.name.padEnd(width)}  ${describeChange(entry)}`);
  const manifestName = relative(cwd, project.manifestPath);
  const { args, env: installEnv } = installCommand(manager);
  out(picocolors.dim(`${manifestName}: ${changing.map((entry) => `"${entry.name}": "${entry.request}"`).join(', ')}`));
  out(picocolors.dim(`$ ${manager} ${args.join(' ')}`));
  if (options.dryRun === true) {
    // The new skill is not installed yet; name the copies a write would reach, without the ones behind a link out of the project.
    const skillDirs = skillCopies(project.dir).filter((dir) => insideProjectRoot(project.dir, path.join(project.dir, dir, SKILL_NAME, 'SKILL.md')));
    if (skillDirs.length > 0) out(picocolors.dim(`then the agent skill in ${listSkillDirs(skillDirs)} from the new e2e`));
    return { result: 'dry-run', exitCode: 0 };
  }

  // The new specs go into package.json and one install resolves them together:
  // an add command per package would meet the old e2e spec in npm's peer check.
  const lockfiles = snapshotLockfiles([project.dir, root]);
  writeFileSync(project.manifestPath, serializePackage(withRequests(project.manifest, changing), project.original), 'utf8');
  const { result, interrupted } = await whileIgnoringSignals(() =>
    (options.spawn ?? spawnInstall)(manager, args, project.dir, { ...env, ...installEnv }),
  );
  const stopped = interrupted || result.signal === 'SIGINT' || result.signal === 'SIGTERM';
  if (result.error !== undefined || result.status !== 0 || stopped) {
    writeFileSync(project.manifestPath, project.original, 'utf8');
    const restored = [manifestName, ...restoreLockfiles(lockfiles).map((file) => relative(cwd, file))];
    const reason = stopped ? 'interrupted' : (result.error?.message ?? `exit ${result.status ?? result.signal}`);
    process.stderr.write(
      `e2e upgrade: ${manager} ${args.join(' ')} failed (${reason}); ${new Intl.ListFormat('en', { type: 'conjunction' }).format(restored)} ${restored.length === 1 ? 'is' : 'are'} back as before. node_modules may hold some new versions until the next ${manager} install\n`,
    );
    return { result: 'install-failed', exitCode: stopped ? 130 : 2 };
  }
  facts.moved = changing.length;

  out(`${picocolors.green('Upgraded')}${where}: ${changing.map((entry) => `${entry.name} ${entry.version}`).join(', ')}`);
  const runnerVersion = versions.get(RUNNER)!;
  if (parseVersion(runnerVersion)?.prerelease.length === 0 && runner.installed !== runnerVersion) {
    out(`Release notes: ${RELEASES_URL}${encodeURIComponent(`${RUNNER}@${runnerVersion}`)}`);
  }
  refreshSkills(project.dir, manager, out);
  if (movedUp(runner.installed, runnerVersion) && process.stdout.isTTY === true && !isCiMode(env)) {
    process.stdout.write(upgradeCelebration(process.stdout, runnerVersion, env));
  }
  return { result: 'upgraded', exitCode: 0 };
}

/** Whether e2e went from `before` to a newer `after`: not a downgrade, not a reinstall. */
function movedUp(before: string | undefined, after: string): boolean {
  const from = before === undefined ? undefined : parseVersion(before);
  const to = parseVersion(after);
  return from !== undefined && to !== undefined && compareVersions(to, from) > 0;
}

type Manifest = ReturnType<typeof readPackage>['manifest'];

/** The nearest package.json from `cwd` up that declares `e2e`, with its text as read. */
function findProject(cwd: string): { dir: string; manifestPath: string; manifest: Manifest; original: string } {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, 'package.json');
    if (existsSync(manifestPath)) {
      let read: ReturnType<typeof readPackage>;
      try {
        read = readPackage(dir);
      } catch (cause) {
        throw new UpgradeError(`${relative(cwd, manifestPath)} could not be read: ${describeManifestError(cause)}`, 'invalid-project', 2);
      }
      const { manifest, original } = read;
      if (original !== undefined && SECTIONS.some((section) => manifest[section]?.[RUNNER] !== undefined)) {
        return { dir, manifestPath, manifest, original };
      }
    }
    if (path.dirname(dir) === dir) break;
  }
  throw new UpgradeError('no package.json from here up lists e2e as a dependency; run e2e init to set up a project', 'no-project', 2);
}

/** `e2e` and the `@e2e-dev/*` packages the manifest installs, split by whether their spec names a registry version. */
function declaredPackages(dir: string, manifest: Manifest): { declared: Declared[]; linked: Declared[] } {
  const seen = new Set<string>();
  const all: Declared[] = [];
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if ((name !== RUNNER && !name.startsWith(SCOPE)) || seen.has(name)) continue;
      seen.add(name);
      all.push({ name, section, spec, installed: installedPackage(dir, name)?.version });
    }
  }
  // The runner leads every list the command prints.
  all.sort((a, b) => Number(b.name === RUNNER) - Number(a.name === RUNNER));
  const registry = (entry: Declared): boolean => !NON_REGISTRY_SPEC.test(entry.spec.trim());
  return { declared: all.filter(registry), linked: all.filter((entry) => !registry(entry)) };
}

/** The registry the package manager would use when it set one for this process, else npm's. */
function registryUrl(env: NodeJS.ProcessEnv): string {
  const configured = env['npm_config_registry']?.trim();
  const base = configured === undefined || configured === '' ? DEFAULT_REGISTRY : configured;
  return base.endsWith('/') ? base : `${base}/`;
}

/** The package's abbreviated metadata, or undefined when the registry has no such package. */
async function fetchPackument(registry: string, name: string, fetchImpl: typeof fetch): Promise<Packument | undefined> {
  const url = `${registry}${name.replaceAll('/', '%2f')}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new UpgradeError(`could not reach the registry at ${registry}: ${cause instanceof Error ? cause.message : String(cause)}`, 'registry-failed', 3);
  }
  if (response.status === 404 && name !== RUNNER) return undefined;
  if (!response.ok) throw new UpgradeError(`the registry at ${registry} answered ${response.status} for ${name}`, 'registry-failed', 3);
  try {
    return packumentSchema.parse(await response.json());
  } catch {
    throw new UpgradeError(`the registry at ${registry} sent metadata for ${name} that could not be read`, 'registry-failed', 3);
  }
}

/** The `e2e` version the target names. */
function resolveRunner(target: UpgradeTarget, packument: Packument | undefined): string {
  if (packument === undefined) throw new UpgradeError('the registry has no e2e package', 'registry-failed', 3);
  const tags = packument['dist-tags'];
  if (target.kind === 'tag') {
    const version = tags[target.tag];
    if (version === undefined) {
      throw new UpgradeError(`e2e has no "${target.tag}" release; its dist-tags are ${Object.keys(tags).join(', ')}`, 'unknown-target', 2);
    }
    return version;
  }
  if (packument.versions[target.version] === undefined) {
    const latest = tags['latest'];
    throw new UpgradeError(`e2e ${target.version} was never published${latest === undefined ? '' : `; the latest release is ${latest}`}`, 'unknown-target', 2);
  }
  return target.version;
}

/**
 * Picks every declared package's version: `e2e` the target, each sibling the
 * release under the same dist-tag when its peer ranges accept the versions
 * chosen so far, else its newest one that does, never deprecated, and a
 * prerelease only when the runner is one. A sibling whose peer is another
 * sibling (an integration on its engine) waits for that one.
 */
function resolveSiblings(
  target: UpgradeTarget,
  runner: string,
  declared: readonly Declared[],
  packuments: ReadonlyMap<string, Packument | undefined>,
  missing: (name: string) => void,
): Map<string, string> {
  const chosen = new Map<string, string>([[RUNNER, runner]]);
  const allowPrerelease = (parseVersion(runner)?.prerelease.length ?? 0) > 0;
  let pending = declared.filter((entry) => entry.name !== RUNNER);
  for (const entry of pending.filter((candidate) => packuments.get(candidate.name) === undefined)) missing(entry.name);
  pending = pending.filter((entry) => packuments.get(entry.name) !== undefined);
  const planned = new Set(pending.map((entry) => entry.name));
  while (pending.length > 0) {
    const ready = pending.filter((entry) =>
      peerNames(packuments.get(entry.name)!).every((peer) => !planned.has(peer) || chosen.has(peer)),
    );
    // Peers that wait on each other: resolve them against what is chosen so far.
    const batch = ready.length > 0 ? ready : pending;
    for (const entry of batch) {
      const packument = packuments.get(entry.name)!;
      chosen.set(entry.name, runnerPin(entry.name, packument, packuments.get(RUNNER), runner) ?? pickSibling(entry.name, packument, target, chosen, allowPrerelease));
    }
    pending = pending.filter((entry) => !batch.includes(entry));
  }
  // A batch of mutual peers was picked against an incomplete plan; the whole plan has to hold.
  for (const name of planned) {
    const peer = unmetPeer(packuments.get(name)!.versions[chosen.get(name)!], chosen);
    if (peer !== undefined) {
      throw new UpgradeError(`no ${name} release fits the rest of the upgrade: ${name} ${chosen.get(name)} needs ${peer.name} ${peer.range}, and the upgrade picks ${peer.name} ${chosen.get(peer.name)}`, 'incompatible', 2);
    }
  }
  return chosen;
}

/**
 * The version of a sibling the runner release itself depends on, when it
 * names one release: the project then installs that one, and one copy serves
 * the runner and whatever peers on it.
 */
function runnerPin(name: string, packument: Packument, runnerPackument: Packument | undefined, runner: string): string | undefined {
  const pinned = runnerPackument?.versions[runner]?.dependencies?.[name];
  return pinned !== undefined && packument.versions[pinned] !== undefined ? pinned : undefined;
}

/**
 * The `@e2e-dev/*` packages the planned releases peer on that the project
 * does not declare, each in the section of the first package that needs it.
 * npm and pnpm install a missing peer themselves; Yarn does not, and under
 * Plug'n'Play the package that peers on it then fails to load.
 */
async function undeclaredPeers(
  target: UpgradeTarget,
  plan: readonly Planned[],
  known: Set<string>,
  packuments: ReadonlyMap<string, Packument | undefined>,
  fetchPeer: (name: string) => Promise<Packument | undefined>,
): Promise<Planned[]> {
  const chosen = new Map(plan.map((entry) => [entry.name, entry.version]));
  const runner = chosen.get(RUNNER)!;
  const allowPrerelease = (parseVersion(runner)?.prerelease.length ?? 0) > 0;
  const added: Planned[] = [];
  for (const entry of plan) {
    const manifest = packuments.get(entry.name)?.versions[entry.version];
    for (const [peer, range] of Object.entries(manifest?.peerDependencies ?? {})) {
      if (!peer.startsWith(SCOPE) || known.has(peer) || manifest?.peerDependenciesMeta?.[peer]?.optional === true) continue;
      known.add(peer);
      const packument = await fetchPeer(peer);
      if (packument === undefined) continue;
      const version = runnerPin(peer, packument, packuments.get(RUNNER), runner) ?? pickSibling(peer, packument, target, chosen, allowPrerelease);
      const parsed = parseVersion(version);
      if (parsed === undefined || !satisfies(parsed, range)) {
        throw new UpgradeError(`no ${peer} release fits the rest of the upgrade: ${entry.name} ${entry.version} needs ${peer} ${range}, and the upgrade picks ${peer} ${version}`, 'incompatible', 2);
      }
      chosen.set(peer, version);
      added.push({ name: peer, section: entry.section, spec: '', installed: undefined, version, request: requestFor('', version, target), peerOf: entry.name });
    }
  }
  return added;
}

/** The first peer range of `manifest` that a version in `chosen` misses; peers outside the plan are not checked. */
function unmetPeer(
  manifest: Packument['versions'][string] | undefined,
  chosen: ReadonlyMap<string, string>,
): { name: string; range: string } | undefined {
  for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    const version = chosen.get(name);
    if (version === undefined) continue;
    const parsed = parseVersion(version);
    if (parsed === undefined || !satisfies(parsed, range)) return { name, range };
  }
  return undefined;
}

/** Every peer any version of the package names. */
function peerNames(packument: Packument): string[] {
  return [...new Set(Object.values(packument.versions).flatMap((manifest) => Object.keys(manifest.peerDependencies ?? {})))];
}

function pickSibling(name: string, packument: Packument, target: UpgradeTarget, chosen: ReadonlyMap<string, string>, allowPrerelease: boolean): string {
  const fits = (version: string): boolean => {
    const manifest = packument.versions[version];
    return manifest !== undefined && manifest.deprecated === undefined && unmetPeer(manifest, chosen) === undefined;
  };
  const tagged = packument['dist-tags'][target.kind === 'tag' ? target.tag : 'latest'];
  if (tagged !== undefined && fits(tagged) && (allowPrerelease || parseVersion(tagged)?.prerelease.length === 0)) return tagged;
  const candidates = Object.keys(packument.versions)
    .flatMap((version) => {
      const parsed = parseVersion(version);
      return parsed !== undefined && (allowPrerelease || parsed.prerelease.length === 0) && fits(version) ? [{ version, parsed }] : [];
    })
    .toSorted((a, b) => compareVersions(b.parsed, a.parsed));
  const [newest] = candidates;
  if (newest !== undefined) return newest.version;
  const latest = packument['dist-tags']['latest'];
  const needs = latest === undefined ? undefined : packument.versions[latest]?.peerDependencies?.[RUNNER];
  throw new UpgradeError(
    `no ${name} release works with e2e ${chosen.get(RUNNER)}${latest !== undefined && needs !== undefined ? `; ${name} ${latest} needs e2e ${needs}` : ''}`,
    'incompatible',
    2,
  );
}

/**
 * The spec to write to package.json. A named version or a prerelease is
 * pinned exactly; a dist-tag keeps the operator of the old spec (`^`, `~`, or
 * none for an exact pin), `^` for any other range.
 */
function requestFor(spec: string, version: string, target: UpgradeTarget): string {
  if (target.kind === 'version' || (parseVersion(version)?.prerelease.length ?? 0) > 0) return version;
  const trimmed = spec.trim();
  const operator = /^([~^])\s*v?\d/u.exec(trimmed)?.[1];
  if (operator !== undefined) return `${operator}${version}`;
  return parseVersion(trimmed.replace(/^=/u, '')) === undefined ? `^${version}` : version;
}

/**
 * Whether the package moves: its installed version differs from the target,
 * or, with nothing under node_modules (Yarn Plug'n'Play, or not installed
 * yet), its spec differs from the one the upgrade would write.
 */
function moves(entry: Planned): boolean {
  return entry.installed === undefined ? entry.spec.trim() !== entry.request : entry.installed !== entry.version;
}

function describeChange(entry: Planned): string {
  if (entry.peerOf !== undefined) return `${picocolors.bold(entry.version)} ${picocolors.dim(`(added: ${entry.peerOf} peers on it)`)}`;
  const from = entry.installed ?? entry.spec;
  if (!moves(entry)) return `${entry.version} ${picocolors.dim('(up to date)')}`;
  const before = entry.installed === undefined ? undefined : parseVersion(entry.installed);
  const after = parseVersion(entry.version);
  const downgrade = before !== undefined && after !== undefined && compareVersions(after, before) < 0;
  return `${from} → ${picocolors.bold(entry.version)}${downgrade ? picocolors.yellow(' (downgrade)') : ''}`;
}

/**
 * The manifest with each moving package's spec set to its request in every
 * section that lists it: a package in both `dependencies` and
 * `optionalDependencies` is installed from the one its manager prefers. An
 * added peer goes into the section of the package that needs it.
 */
function withRequests(manifest: Manifest, entries: readonly Planned[]): Manifest {
  const sections = SECTIONS.flatMap((section) => {
    const block = manifest[section];
    if (block === undefined) return [];
    const moved = entries
      .filter((entry) => (entry.peerOf === undefined ? block[entry.name] !== undefined : entry.section === section))
      .map((entry) => [entry.name, entry.request] as const);
    return [[section, { ...block, ...Object.fromEntries(moved) }] as const];
  });
  return { ...manifest, ...Object.fromEntries(sections) };
}

function spawnInstall(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): SpawnOutcome {
  return spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
}

/**
 * Runs `install` with Ctrl-C and SIGTERM held off this process. The terminal
 * sends Ctrl-C to the package manager too, which stops on its own; without a
 * listener the signal would kill e2e first, before it puts package.json back.
 */
async function whileIgnoringSignals<T>(install: () => T): Promise<{ result: T; interrupted: boolean }> {
  let interrupted = false;
  const hold = (): void => {
    interrupted = true;
  };
  process.on('SIGINT', hold);
  process.on('SIGTERM', hold);
  try {
    const result = install();
    // A signal that arrived during the synchronous install is delivered on the next turn of the loop.
    await new Promise((resolve) => setImmediate(resolve));
    return { result, interrupted };
  } finally {
    process.off('SIGINT', hold);
    process.off('SIGTERM', hold);
  }
}

/** Every lockfile in `dirs` as it is now, absent ones included, so a failed install can put them back. */
function snapshotLockfiles(dirs: readonly string[]): Map<string, Buffer | undefined> {
  const snapshot = new Map<string, Buffer | undefined>();
  for (const dir of new Set(dirs)) {
    for (const name of LOCKFILE_NAMES) {
      const file = path.join(dir, name);
      // Bytes, not text: `bun.lockb` is binary.
      snapshot.set(file, existsSync(file) ? readFileSync(file) : undefined);
    }
  }
  return snapshot;
}

/** Puts back every lockfile the install changed, created, or removed; returns their paths. */
function restoreLockfiles(snapshot: ReadonlyMap<string, Buffer | undefined>): string[] {
  const restored: string[] = [];
  for (const [file, before] of snapshot) {
    const now = existsSync(file) ? readFileSync(file) : undefined;
    if (now === undefined ? before === undefined : before !== undefined && now.equals(before)) continue;
    if (before === undefined) rmSync(file, { force: true });
    else writeFileSync(file, before);
    restored.push(file);
  }
  return restored;
}

/**
 * Brings every copy of the agent skill in the project to the installed e2e's,
 * the files under `node_modules/e2e/skills/e2e`: after the install, the new
 * version's, which the running process does not have. Copies that already
 * match are left alone, and a file an earlier e2e shipped and the new one does
 * not is removed, as with `e2e init`; a file no e2e shipped stays. A link the
 * package manager keeps on the installed skill, as pnpm links it, needs
 * nothing, and a copy beside one under another name is named as a second
 * skill. A symlink to a copy outside the project and an entry a write
 * cannot pass are named and never written through. With no installed package
 * to read (Yarn Plug'n'Play), the line names the init command instead.
 */
function refreshSkills(projectDir: string, manager: PackageManager, out: (text: string) => void, dryRun = false): void {
  const packageLinks = findPackageSkillLinks(projectDir);
  for (const duplicate of findDuplicateSkills(projectDir, packageLinks)) out(picocolors.yellow(describeDuplicate(duplicate)));
  const dirs = skillCopies(projectDir, packageLinks);
  if (dirs.length === 0) return;
  const installed = installedPackage(projectDir, RUNNER);
  const skillDir = installed === undefined ? undefined : packagedSkillDirectory(installed.dir);
  const bundled = skillDir === undefined ? [] : readSkillFiles(skillDir);
  if (bundled.length === 0) {
    out(`The agent skill in ${listSkillDirs(dirs)} may be the old version's; refresh it with ${execCommand(manager, 'e2e init')}`);
    return;
  }
  for (const install of planSkillInstall(projectDir, dirs, bundled)) {
    if (install.obstacles.length > 0) {
      out(picocolors.yellow(`Broken, not touching: ${describeObstacles(install)}`));
      continue;
    }
    if (install.kind === 'link' || install.links.length > 0) {
      out(picocolors.yellow(`Symlink, not touching: ${describeLinks(install)}; the copy it leads to is updated where it lives`));
      continue;
    }
    if (dryRun) {
      const removing = install.retired.length === 0 ? '' : ` and remove ${install.retired.join(', ')}`;
      out(picocolors.dim(`Would update the agent skill in ${install.relative}/${removing}`));
      continue;
    }
    try {
      writeSkillCopy(projectDir, install);
    } catch (cause) {
      // The packages are installed by now; a skill copy that cannot be written does not undo that.
      out(picocolors.yellow(`Could not update the agent skill in ${install.relative}/ (${cause instanceof Error ? cause.message : String(cause)}); refresh it with ${execCommand(manager, 'e2e init')}`));
      continue;
    }
    out(`Updated the agent skill in ${install.relative}/ (${describeCopy(install)})`);
  }
}

/**
 * The skill locations the project holds a copy in, leaving out one reached
 * through a symlink to another location's copy (`.claude/skills/e2e`, as
 * `e2e init` links it): refreshing that copy refreshes it. A location whose
 * `e2e` is a package link is left out as well.
 */
function skillCopies(projectDir: string, packageLinks = findPackageSkillLinks(projectDir)): string[] {
  const found = findInstalledSkillDirs(projectDir).filter((dir) => !linkedAtSkillName(packageLinks, dir));
  const root = realpathOfExisting(projectDir);
  const real = (dir: string): string => realpathOfExisting(path.join(projectDir, dir, SKILL_NAME));
  const direct = (dir: string): boolean => real(dir) === path.join(root, dir, SKILL_NAME);
  return found.filter((dir) => direct(dir) || !found.some((other) => other !== dir && direct(other) && real(other) === real(dir)));
}

/** `.agents/skills/e2e and .claude/skills/e2e`, for a message. */
function listSkillDirs(dirs: readonly string[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(dirs.map((dir) => `${dir}/${SKILL_NAME}`));
}

/** A path for a message: relative to the working directory, `.` for the directory itself. */
function relative(cwd: string, target: string): string {
  return path.relative(cwd, target) || '.';
}
