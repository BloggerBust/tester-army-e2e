/** `e2e guide`: prints the bundled agent skill for agents and people who do not have it installed. */

import path from 'node:path';
import { execCommand } from '../internal/package-manager.ts';
import { installedPackage } from '../internal/installed-package.ts';
import { declaringPackage, RUNNER } from '../internal/project-package.ts';
import { parseVersion, specAccepts } from '../internal/semver.ts';
import { MISSING_SKILL_MESSAGE, packagedSkillDirectory, readGuide, skillTopics } from './skill.ts';

export interface GuideOptions {
  /** The version of the CLI that runs the command. */
  readonly version: string;
  /** The project directory; the working directory when absent. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface GuideSource {
  /** The skill directory to read, or undefined for this CLI's own. */
  readonly from: string | undefined;
  /** One line for stderr: the version the guide is for, and what to do when the project uses another. */
  readonly notice: string;
}

/**
 * Which copy of the guide matches the project in `cwd`. `npx e2e guide`
 * downloads the latest release when the project's own e2e is not installed
 * yet, and a global install is whatever it is, so the running CLI is not
 * always the version the tests will run on. An installed copy of another
 * version is read instead of this one, unless package.json has moved past
 * it to a range this CLI is in; a declared version with no installed copy
 * can only be named, and a spec that is no range (a tag, a workspace link)
 * says nothing about either.
 */
function guideSource({ version, cwd = process.cwd(), env = process.env }: GuideOptions): GuideSource {
  const declared = declaringPackage(cwd, RUNNER, env);
  const installed = installedPackage(path.resolve(cwd), RUNNER);
  const own = { from: undefined, notice: `Guide for e2e ${version}` };
  // Nothing to hold a version against: no package.json lists e2e, or its sections disagree and the manager's pick is not known.
  if (declared?.spec === undefined) {
    if (installed === undefined || installed.version === version) return own;
    return installedGuide(installed, version, '');
  }
  const { spec, manager } = declared;
  const accepts = (candidate: string): boolean | undefined => {
    const parsed = parseVersion(candidate);
    return parsed === undefined ? undefined : specAccepts(spec, parsed);
  };
  const manifest = path.relative(cwd, path.join(declared.dir, 'package.json'));
  if (installed === undefined) {
    if (accepts(version) !== false) return own;
    const missing = `${own.notice}, but ${manifest} declares e2e ${spec} and no installed copy was found.`;
    const install = `run \`${manager} install\` and then \`${execCommand(manager, 'e2e guide')}\``;
    if (parseVersion(spec) !== undefined) return { from: undefined, notice: `${missing} For the matching guide, ${install}, or run \`npx e2e@${spec} guide\`.` };
    // A range names many releases, each with its own guide; only an install says which one the project runs.
    return {
      from: undefined,
      notice: `${missing} For the guide of the version the project installs, ${install}; \`npx "e2e@${spec}" guide\` prints the newest release in that range, which may not be the one the lockfile pins.`,
    };
  }
  const stale = accepts(installed.version) === false;
  const reinstall = `${manifest} declares e2e ${spec}, which the installed e2e ${installed.version} is outside of; run \`${manager} install\``;
  if (installed.version === version) return stale ? { from: undefined, notice: `${own.notice}, but ${reinstall} for the matching guide` } : own;
  if (stale && accepts(version) === true) return { from: undefined, notice: `${own.notice}. ${reinstall}` };
  return installedGuide(installed, version, stale ? `. ${reinstall} for the matching guide` : '');
}

function installedGuide(installed: { dir: string; version: string }, version: string, suffix: string): GuideSource {
  const from = packagedSkillDirectory(installed.dir);
  return from === undefined
    ? { from, notice: `Guide for e2e ${version}; the project's installed e2e ${installed.version} ships no guide${suffix}` }
    : { from, notice: `Guide for e2e ${installed.version}, the version installed in this project (this CLI is e2e ${version})${suffix}` };
}

/** The topics of the guide `guide` prints for the project, which an installed copy of another version may name differently. */
export function guideTopics(options: GuideOptions): readonly string[] {
  return skillTopics(guideSource(options).from);
}

/**
 * Prints the overview or one topic to stdout, and the version it is for to
 * stderr, so stdout stays the guide alone; an unknown topic exits 2.
 */
export function guide(topic: string | undefined, options: GuideOptions): number {
  const { from, notice } = guideSource(options);
  const text = readGuide(topic, from);
  if (text === undefined) {
    const topics = skillTopics(from);
    // The topics are the read copy's, so the line that names its version comes first.
    process.stderr.write(topics.length === 0 ? `${MISSING_SKILL_MESSAGE}\n` : `${notice}\nunknown topic "${topic}"; topics: ${topics.join(', ')}\n`);
    return 2;
  }
  process.stderr.write(`${notice}\n`);
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  return 0;
}
