/** The `e2e init` step that installs the bundled skill for coding agents. */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import path from 'node:path';
import { insideProjectRoot, realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { RUNNER } from '../../internal/project-package.ts';
import { MISSING_SKILL_MESSAGE, SHIPPED_SKILL_FILES, SKILL_NAME, type SkillFile } from '../skill.ts';

interface SkillLocation {
  /** Project-relative skills directory with `/` separators. */
  readonly dir: string;
  /** The agents that read it, shown as the prompt hint. */
  readonly hint: string;
  /**
   * The location whose copy this one links to when both are chosen, so one
   * copy serves every agent: the layout `npx skills add` produces.
   */
  readonly linksTo?: string;
}

/** Where project skills live: most agents read `.agents/skills`; Claude Code reads `.claude/skills`. */
export const SKILL_LOCATIONS: readonly SkillLocation[] = [
  { dir: '.agents/skills', hint: 'Codex, Cursor, Copilot, Gemini CLI, OpenCode, Zed, and most other agents' },
  { dir: '.claude/skills', hint: 'Claude Code, as a symlink into .agents/skills when both are chosen', linksTo: '.agents/skills' },
];

/** A symlink on the way to a skill file. */
interface SkillLink {
  /** Project-relative path of the link with `/` separators, e.g. `.claude/skills/e2e`. */
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

/** An entry a write cannot pass: a directory where a bundled file goes, or a file where its directory goes. */
interface SkillObstacle {
  /** Path relative to the skill directory with `/` separators, e.g. `SKILL.md`. */
  readonly relative: string;
  readonly kind: 'directory' | 'file';
}

interface SkillInstallBase {
  /** Project-relative skill directory, e.g. `.agents/skills/e2e`. */
  readonly relative: string;
  /** True when the directory already holds a copy: a copy updates it, a link replaces it. */
  readonly existing: boolean;
  /**
   * The symlinks between the project root and the files, each once, plus any
   * file that resolves outside the project without one. Init never writes
   * through them: a link to a dotfiles repo or a shared skills folder would
   * be overwritten there.
   */
  readonly links: readonly SkillLink[];
  /** Entries the writes would fail on, each once; removing them is not a repair init makes. */
  readonly obstacles: readonly SkillObstacle[];
}

/** The bundled files, written into the skill directory. */
interface SkillCopy extends SkillInstallBase {
  readonly kind: 'copy';
  readonly files: readonly { readonly absolute: string; readonly content: string }[];
  /**
   * Files an earlier e2e shipped and the bundle no longer does, removed with
   * the write: each a regular file in the project, reached through no
   * symlink. Paths relative to the skill directory with `/` separators.
   */
  readonly retired: readonly string[];
}

/** A symlink standing in for the skill directory, leading to the copy in another location. */
interface SkillSymlink extends SkillInstallBase {
  readonly kind: 'link';
  /** The link as written, relative to its parent with `/` separators: `../../.agents/skills/e2e`. */
  readonly target: string;
}

export type SkillInstall = SkillCopy | SkillSymlink;

/**
 * A link in a skills directory that leads to the skill an installed e2e
 * ships, as pnpm 12.11 or later links a dependency's skills: `pnpm-e2e-e2e`
 * before pnpm 12.18, and from 12.18 `e2e` unless that name is taken. The
 * package manager keeps it on the installed version, so init and upgrade
 * write nothing there.
 */
export interface PackageSkillLink {
  /** The skills directory, e.g. `.agents/skills`. */
  readonly dir: string;
  /** The link's name in it, e.g. `e2e` or `pnpm-e2e-e2e`. */
  readonly name: string;
}

/**
 * Every link in a known location that leads to an installed e2e's skill. A
 * link is told by where it resolves, `node_modules/e2e/skills/e2e` with a
 * `SKILL.md`, not by its name or by the package `node_modules/e2e` resolves
 * to, since pnpm may link a peer variant's directory.
 */
export function findPackageSkillLinks(cwd: string): PackageSkillLink[] {
  return SKILL_LOCATIONS.flatMap(({ dir }) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isSymbolicLink() && leadsToPackageSkill(path.join(cwd, dir, entry.name)))
      .map((entry) => ({ dir, name: entry.name }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * The package links beside which `<dir>/e2e` holds another skill, a copy or a
 * link to one: an agent reading the directory loads two e2e skills.
 */
export function findDuplicateSkills(cwd: string, links: readonly PackageSkillLink[]): PackageSkillLink[] {
  return links.filter((link) =>
    link.name !== SKILL_NAME
    && !links.some((other) => other.dir === link.dir && other.name === SKILL_NAME)
    && holdsSkill(cwd, link.dir),
  );
}

/**
 * The warning for another skill beside a package link: delete it, and for
 * pnpm's link, reinstall with `--force` so pnpm 12.18 or later renames the
 * link to `e2e`, the path the instructions files name.
 */
export function describeDuplicate(link: PackageSkillLink): string {
  const rename = link.name.startsWith('pnpm-') ? ' and run pnpm install --force' : '';
  return `Two e2e skills in ${link.dir}: ${SKILL_NAME} and ${link.name}, the link to the installed e2e; delete ${link.dir}/${SKILL_NAME}${rename}`;
}

/** Whether `<dir>/e2e` holds a skill an agent loads: a `SKILL.md` there, through any link. */
export function holdsSkill(cwd: string, dir: string): boolean {
  return existsSync(path.join(cwd, dir, SKILL_NAME, 'SKILL.md'));
}

/** Whether `<dir>/e2e` is itself a link to an installed e2e's skill. */
export function linkedAtSkillName(links: readonly PackageSkillLink[], dir: string): boolean {
  return links.some((link) => link.dir === dir && link.name === SKILL_NAME);
}

/**
 * Known locations that hold a copy of the skill. The directory is the marker,
 * not `SKILL.md`, so a copy that lost files is repaired rather than ignored.
 */
export function findInstalledSkillDirs(cwd: string): string[] {
  return SKILL_LOCATIONS.map((location) => location.dir).filter((dir) => existsSync(path.join(cwd, dir, SKILL_NAME)));
}

/** The chosen directories split into the ones written as a copy and the ones linked to a copy among them. */
export function splitSkillDirs(dirs: readonly string[]): { copies: string[]; links: { dir: string; linksTo: string }[] } {
  const links = SKILL_LOCATIONS.flatMap((location) =>
    location.linksTo !== undefined && dirs.includes(location.dir) && dirs.includes(location.linksTo)
      ? [{ dir: location.dir, linksTo: location.linksTo }]
      : [],
  );
  return { copies: dirs.filter((dir) => !links.some((link) => link.dir === dir)), links };
}

/**
 * Plans the writes for the given directories from the bundled files. A
 * directory without the skill is created and one whose copy differs from the
 * bundle, or holds a file an earlier e2e shipped and the bundle does not, is
 * rewritten; an up-to-date copy needs nothing and is left out. Files no e2e
 * shipped, such as a project's own notes, are never removed. A location reached through a
 * symlink, or holding an entry a write cannot pass, is planned with what was
 * met and never read, for the caller to skip or replace. An empty bundle with
 * somewhere to write is a broken installation, never a set of current copies.
 */
export function planSkillInstall(cwd: string, dirs: readonly string[], bundled: readonly SkillFile[]): SkillInstall[] {
  if (dirs.length > 0 && bundled.length === 0) throw new Error(MISSING_SKILL_MESSAGE);
  const installs: SkillInstall[] = [];
  for (const dir of dirs) {
    const root = path.join(cwd, dir, SKILL_NAME);
    const files = bundled.map((file) => ({ absolute: path.join(root, file.relative), content: file.content }));
    const { links, obstacles } = findBlockers(cwd, root, files.map((file) => file.absolute));
    const retired = links.length > 0 ? [] : retiredFiles(cwd, root, bundled);
    const current = links.length === 0 && obstacles.length === 0 && retired.length === 0
      && files.every((file) => currentContent(file.absolute) === file.content);
    if (current) continue;
    installs.push({ kind: 'copy', relative: `${dir}/${SKILL_NAME}`, existing: existsSync(root), files, retired, links, obstacles });
  }
  return installs;
}

/**
 * Writes a planned copy: every bundled file, then the retired files removed,
 * with each directory that removal left empty inside the skill directory.
 */
export function writeSkillCopy(cwd: string, install: SkillCopy): void {
  for (const file of install.files) {
    mkdirSync(path.dirname(file.absolute), { recursive: true });
    writeFileSync(file.absolute, file.content, 'utf8');
  }
  const root = path.join(cwd, install.relative);
  for (const relative of install.retired) {
    const absolute = path.join(root, relative);
    unlinkSync(absolute);
    for (let parent = path.dirname(absolute); parent !== root && readdirSync(parent).length === 0; parent = path.dirname(parent)) {
      rmdirSync(parent);
    }
  }
}

/** The copy's write for a message: `8 files`, then `; removed references/x.md` when it removes any. */
export function describeCopy(install: SkillCopy): string {
  const count = `${install.files.length} ${install.files.length === 1 ? 'file' : 'files'}`;
  return install.retired.length === 0 ? count : `${count}; removed ${install.retired.join(', ')}`;
}

/**
 * Whether a directory holds the copy once the planned writes are done: its
 * plan goes ahead, or nothing was planned because the copy is current.
 */
export function holdsCopyAfter(dir: string, planned: readonly SkillInstall[], going: readonly SkillInstall[]): boolean {
  const relative = `${dir}/${SKILL_NAME}`;
  return going.some((install) => install.relative === relative) || !planned.some((install) => install.relative === relative);
}

/**
 * Plans `dir` as a symlink to the copy in `canonicalDir`, which `ready` says
 * this run leaves in place. Nothing is planned for an entry that already
 * leads there, the link itself or a linked parent. A copy holding only
 * bundled files is replaced by the link, since the copy it leads to has the
 * same content; one holding anything else, like a location whose copy is not
 * ready, is planned as a copy like any other. A symlink leading elsewhere,
 * or one on the way, is planned with what was met, for the caller to skip or
 * replace.
 */
export function planSkillLink(
  cwd: string,
  dir: string,
  canonicalDir: string,
  bundled: readonly SkillFile[],
  ready: boolean,
): SkillInstall | undefined {
  const link = path.join(cwd, dir, SKILL_NAME);
  const canonical = path.join(cwd, canonicalDir, SKILL_NAME);
  if (ready && leadsTo(link, canonical)) return undefined;
  const entry = lstatOrUndefined(link);
  const linkable = entry === undefined || entry.isSymbolicLink() || (entry.isDirectory() && holdsOnlyBundled(link, bundled));
  if (!ready || !linkable) return planSkillInstall(cwd, [dir], bundled)[0];
  const blocker = firstBlocker(cwd, path.dirname(link), 'directory')
    ?? (entry?.isSymbolicLink() ? { kind: 'link' as const, absolute: link } : undefined);
  const found = describeBlocker(cwd, link, link, blocker);
  return {
    kind: 'link',
    relative: `${dir}/${SKILL_NAME}`,
    existing: entry?.isDirectory() === true,
    target: posixRelative(path.dirname(link), canonical),
    links: found !== undefined && 'link' in found ? [found.link] : [],
    obstacles: found !== undefined && 'obstacle' in found ? [found.obstacle] : [],
  };
}

/**
 * Whether removing the install's links leaves everything but the skill in
 * place: each is the skill directory or inside it. A linked parent
 * (`.claude/skills`) holds more than the skill, so a copy cannot stand in
 * for it.
 */
export function replaceableLinks(install: SkillInstall): boolean {
  return install.links.every((link) => link.relative.startsWith(install.relative));
}

/**
 * The install's links for a message: a skill directory that is itself the
 * link reads `dir -> target`; otherwise the directory, then the links in
 * parentheses.
 */
export function describeLinks(install: SkillInstall): string {
  const links = install.links.map((link) => `${link.relative} -> ${link.target}`).join(', ');
  const [only] = install.links;
  return install.links.length === 1 && only?.relative === install.relative ? links : `${install.relative}/ (${links})`;
}

/** The install's obstacles for a message: the directory, then each entry and what it is in parentheses. */
export function describeObstacles(install: SkillInstall): string {
  return `${install.relative}/ (${install.obstacles.map((obstacle) => `${obstacle.relative} is a ${obstacle.kind}`).join(', ')})`;
}

/**
 * The files under `root` an earlier e2e shipped and `bundled` does not: each
 * a regular file reached through no symlink, inside the project.
 */
function retiredFiles(cwd: string, root: string, bundled: readonly SkillFile[]): string[] {
  const shipped = new Set(bundled.map((file) => file.relative));
  return SHIPPED_SKILL_FILES.filter((relative) => {
    if (shipped.has(relative)) return false;
    const absolute = path.join(root, relative);
    return lstatOrUndefined(absolute)?.isFile() === true && firstBlocker(cwd, absolute, 'file') === undefined && insideProjectRoot(cwd, absolute);
  });
}

/** Whether `entry` resolves to the skill an installed e2e package ships. */
function leadsToPackageSkill(entry: string): boolean {
  let real: string;
  try {
    real = realpathSync(entry);
  } catch {
    return false;
  }
  return real.split(path.sep).slice(-4).join('/') === `node_modules/${RUNNER}/skills/${SKILL_NAME}` && existsSync(path.join(real, 'SKILL.md'));
}

/** The content a bundled file currently has, or undefined when it cannot be read as a file, which differs from any bundle. */
function currentContent(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether `link` already leads to `canonical`: it resolves there through the
 * filesystem, a linked parent included, or it is a symlink written to point
 * there whose target does not exist yet.
 */
function leadsTo(link: string, canonical: string): boolean {
  return realpathOfExisting(link) === realpathOfExisting(canonical);
}

/**
 * Whether the directory holds nothing but regular files the bundle ships, so a
 * link to another copy loses nothing. A symlink inside is a link to respect
 * under the copy rules, never a file to drop.
 */
function holdsOnlyBundled(root: string, bundled: readonly SkillFile[]): boolean {
  const shipped = [...bundled.map((file) => file.relative), ...SHIPPED_SKILL_FILES];
  return readdirSync(root, { recursive: true, withFileTypes: true }).every((entry) => {
    const relative = posixRelative(root, path.join(entry.parentPath, entry.name));
    return entry.isDirectory() ? shipped.some((file) => file.startsWith(`${relative}/`)) : entry.isFile() && shipped.includes(relative);
  });
}

type Blocker = { readonly kind: 'link' | SkillObstacle['kind']; readonly absolute: string };

/**
 * What stands between the project root and the given files, each once: the
 * first symlink on a path (components past it live wherever it points and are
 * not inspected), a file that resolves outside the project without one, and
 * the entries a write cannot pass.
 */
function findBlockers(cwd: string, root: string, files: readonly string[]): Pick<SkillInstallBase, 'links' | 'obstacles'> {
  const links = new Map<string, SkillLink>();
  const obstacles = new Map<string, SkillObstacle>();
  for (const file of files) {
    const found = describeBlocker(cwd, root, file, firstBlocker(cwd, file, 'file'));
    if (found === undefined) continue;
    if ('link' in found) links.set(found.link.relative, found.link);
    else obstacles.set(found.obstacle.relative, found.obstacle);
  }
  return { links: [...links.values()], obstacles: [...obstacles.values()] };
}

/**
 * A blocker as the plan spells it: a symlink with where it leads, the entry
 * a write cannot pass relative to the skill directory, or, with no blocker
 * on the path, `file` itself when it resolves outside the project.
 */
function describeBlocker(
  cwd: string,
  root: string,
  file: string,
  blocker: Blocker | undefined,
): { link: SkillLink } | { obstacle: SkillObstacle } | undefined {
  if (blocker === undefined) {
    if (insideProjectRoot(cwd, file)) return undefined;
    return { link: { relative: posixRelative(cwd, file), target: realpathOfExisting(file) } };
  }
  if (blocker.kind === 'link') return { link: { relative: posixRelative(cwd, blocker.absolute), target: linkTarget(blocker.absolute) } };
  return { obstacle: { relative: posixRelative(root, blocker.absolute), kind: blocker.kind } };
}

/**
 * The first entry from the project root down to `target`, wanted as a file
 * or as a directory, that a write cannot go through as planned.
 */
function firstBlocker(cwd: string, target: string, wants: 'file' | 'directory'): Blocker | undefined {
  const segments = path.relative(cwd, target).split(path.sep);
  let current = cwd;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = lstatOrUndefined(current);
    if (entry === undefined) return undefined;
    if (entry.isSymbolicLink()) return { kind: 'link', absolute: current };
    const wantsFile = wants === 'file' && index === segments.length - 1;
    if (wantsFile && entry.isDirectory()) return { kind: 'directory', absolute: current };
    if (!wantsFile && !entry.isDirectory()) return { kind: 'file', absolute: current };
  }
  return undefined;
}

/** The entry at `target` without following a final symlink; undefined when missing or unreachable. */
function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Where a symlink leads: its real path, or the path as written when it dangles. */
function linkTarget(link: string): string {
  return existsSync(link) ? realpathSync(link) : path.resolve(path.dirname(link), readlinkSync(link));
}

/** `absolute` relative to `from` with `/` separators, as the messages and the plan spell paths. */
function posixRelative(from: string, absolute: string): string {
  return path.relative(from, absolute).split(path.sep).join('/');
}
