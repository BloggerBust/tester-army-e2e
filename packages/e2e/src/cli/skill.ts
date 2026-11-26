/** The bundled agent skill: `SKILL.md` plus one reference file per `e2e guide` topic. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'e2e';

/** Printed when a build or an install left the skill files out of the package. */
export const MISSING_SKILL_MESSAGE = 'this installation ships no skill files; reinstall e2e';

/**
 * Every file the skill has shipped, relative to its directory. Append-only:
 * a file removed from the skill keeps its line, so `e2e init` and
 * `e2e upgrade` remove it from a project's copy, and a file a project adds
 * under any other path stays. `e2e upgrade` runs the CLI from before the
 * install, so the list it reads is the old version's, which holds every file
 * that version's copy can have.
 */
export const SHIPPED_SKILL_FILES: readonly string[] = [
  'SKILL.md',
  'references/agent.md',
  'references/bug-bash.md',
  'references/debugging.md',
  'references/explore.md',
  'references/mcp.md',
  'references/running.md',
  'references/setup.md',
  'references/writing-tests.md',
];

const TOPIC_PREFIX = 'references/';

/**
 * The published package ships the skill at `<package>/skills/e2e`, copied from
 * the repository's `skills/e2e` by the build. That copy is tried first so a
 * user project's own `skills/` directory is never mistaken for it; inside the
 * repository the source directory is read directly, so nothing here needs a
 * build. Undefined only for a broken installation.
 */
function skillDirectory(): string | undefined {
  for (const candidate of ['../../skills/e2e/', '../../../../skills/e2e/']) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return undefined;
}

/** The skill an installed copy of the package at `packageDir` ships, or undefined when it ships none. */
export function packagedSkillDirectory(packageDir: string): string | undefined {
  const dir = path.join(packageDir, 'skills', SKILL_NAME);
  return existsSync(path.join(dir, 'SKILL.md')) ? dir : undefined;
}

export interface SkillFile {
  /** Path relative to the skill root with `/` separators. */
  readonly relative: string;
  readonly content: string;
}

/**
 * Every file of the skill, `SKILL.md` first, or none when the installation
 * lacks it. `from` reads another installation's copy, such as the one
 * `e2e upgrade` has just installed, instead of this one's.
 */
export function readSkillFiles(from?: string): readonly SkillFile[] {
  const root = from ?? skillDirectory();
  if (root === undefined) return [];
  const files: SkillFile[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push({ relative: path.relative(root, absolute).split(path.sep).join('/'), content: readFileSync(absolute, 'utf8') });
    }
  };
  walk(root);
  return [...files.filter((file) => file.relative === 'SKILL.md'), ...files.filter((file) => file.relative !== 'SKILL.md')];
}

/** Topics `e2e guide <topic>` accepts: one per `references/<topic>.md`. `from` as in `readSkillFiles`. */
export function skillTopics(from?: string): readonly string[] {
  return readSkillFiles(from)
    .filter((file) => file.relative.startsWith(TOPIC_PREFIX) && file.relative.endsWith('.md'))
    .map((file) => file.relative.slice(TOPIC_PREFIX.length, -'.md'.length));
}

/**
 * The overview (`SKILL.md` without its frontmatter) or one topic's text;
 * undefined for an unknown topic. `from` as in `readSkillFiles`.
 */
export function readGuide(topic: string | undefined, from?: string): string | undefined {
  const files = readSkillFiles(from);
  if (topic === undefined) {
    return files.find((file) => file.relative === 'SKILL.md')?.content.replace(/^---\n[\s\S]*?\n---\n+/, '');
  }
  return files.find((file) => file.relative === `${TOPIC_PREFIX}${topic}.md`)?.content;
}
