/**
 * The `e2e init` step that points coding agents at the installed skill from
 * the project's instructions files, so a later prompt such as "add a test for
 * checkout" reaches e2e without naming it.
 */

import { appendFileSync, lstatSync, readFileSync, statSync, type Stats } from 'node:fs';
import path from 'node:path';
import { onDiskPath, realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { SKILL_NAME } from '../skill.ts';
import type { SkillInstall } from './agent-skill.ts';

/** The instructions file each skills directory's agents read: `AGENTS.md` for most, `CLAUDE.md` for Claude Code. */
const INSTRUCTIONS_FILES: readonly { readonly file: string; readonly skillDir: string }[] = [
  { file: 'AGENTS.md', skillDir: '.agents/skills' },
  { file: 'CLAUDE.md', skillDir: '.claude/skills' },
];

/** The encodings init appends in: UTF-8, and UTF-16 when the file opens with its byte order mark. */
type Encoding = 'utf8' | 'utf16le' | 'utf16be';

/** An instructions file's text and the encoding it was read in. */
interface InstructionsText {
  readonly content: string;
  readonly encoding: Encoding;
}

interface InstructionsWrite {
  /** Project-relative file, e.g. `AGENTS.md`. */
  readonly relative: string;
  /** True when the file already existed, so the write appends to it. */
  readonly existing: boolean;
  readonly absolute: string;
  /** The pointer line, as the message shows it when the write fails. */
  readonly line: string;
  /** What goes at the end of the file, in the file's encoding; nothing before it is rewritten, so its bytes stay as they are. */
  readonly appended: Buffer;
}

/** A write for a file that imports another instructions file, made only when the write to `after` fails. */
interface InstructionsFallback extends InstructionsWrite {
  /** Project-relative file whose planned line this file would have imported. */
  readonly after: string;
}

/** An instructions file that is a symlink init will not write through. */
interface InstructionsLink {
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

/** An instructions file init cannot read as a file. */
interface InstructionsObstacle {
  readonly relative: string;
  readonly reason: string;
}

/** What init plans for the instructions files: the writes, and the entries it leaves alone. */
interface InstructionsPlan {
  readonly writes: readonly InstructionsWrite[];
  readonly fallbacks: readonly InstructionsFallback[];
  readonly links: readonly InstructionsLink[];
  readonly obstacles: readonly InstructionsObstacle[];
}

/** One attempted write; `error` is the failure's message. */
interface InstructionsOutcome {
  readonly write: InstructionsWrite;
  readonly error: string | undefined;
}

/** What is at an instructions file's path. A link's `text` is undefined unless it leads to a file init can read. */
type InstructionsEntry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'obstacle'; readonly reason: string }
  | { readonly kind: 'file'; readonly text: InstructionsText }
  | { readonly kind: 'link'; readonly text: InstructionsText | undefined };

/**
 * Plans the pointer line for the instructions file of each chosen skills
 * directory that holds the skill once `going` is written. A missing file is
 * created with the line and an existing one gets it appended. A file needs
 * nothing when it already names a skill file this run leaves in place, or
 * when it hands over to another instructions file that has the line: a
 * symlink to it, or a Claude Code `@AGENTS.md` import. A file that imports
 * one this run only plans the line for is returned among `fallbacks`. A
 * symlink to anything but a file with the line is returned among `links`,
 * and a directory or a file init cannot read among `obstacles`, for the
 * caller to report and skip.
 */
export function planAgentInstructions(cwd: string, skillDirs: readonly string[], going: readonly SkillInstall[]): InstructionsPlan {
  const goingPaths = new Set(going.map((install) => onDiskPath(path.join(cwd, install.relative))));
  const held = skillDirs.filter((dir) =>
    isFile(path.join(cwd, skillFile(dir))) || goingPaths.has(onDiskPath(path.join(cwd, dir, SKILL_NAME))),
  );
  const mentions = held.map(skillFile);
  const files = INSTRUCTIONS_FILES.filter(({ skillDir }) => held.includes(skillDir)).map(({ file, skillDir }) => {
    const absolute = path.join(cwd, file);
    return { file, skillDir, absolute, entry: inspect(absolute) };
  });
  /** On-disk paths of the files that carry a pointer now. */
  const pointed = new Set<string>();
  for (const { absolute, entry } of files) {
    const text = entry.kind === 'file' || entry.kind === 'link' ? entry.text : undefined;
    if (text !== undefined && namesSkillFile(cwd, text.content, mentions)) pointed.add(onDiskPath(absolute));
  }
  const writes: InstructionsWrite[] = [];
  const fallbacks: InstructionsFallback[] = [];
  const obstacles: InstructionsObstacle[] = [];
  /** The file this run plans the line for, by on-disk path. */
  const planned = new Map<string, string>();
  for (const { file, skillDir, absolute, entry } of files) {
    if (entry.kind === 'obstacle') obstacles.push({ relative: file, reason: entry.reason });
    if (entry.kind === 'obstacle' || entry.kind === 'link' || pointed.has(onDiskPath(absolute))) continue;
    const text: InstructionsText = entry.kind === 'file' ? entry.text : { content: '', encoding: 'utf8' };
    const imported = importedFiles(cwd, text.content);
    if (imported.some((target) => pointed.has(target))) continue;
    const line = `End-to-end tests use e2e; read ${skillFile(skillDir)} before writing or running one.`;
    const write = { relative: file, existing: entry.kind === 'file', absolute, line, appended: encode(appendedLine(text.content, line), text.encoding) };
    const after = imported.map((target) => planned.get(target)).find((relative) => relative !== undefined);
    if (after === undefined) {
      writes.push(write);
      planned.set(onDiskPath(absolute), file);
    } else {
      fallbacks.push({ ...write, after });
    }
  }
  const links = files
    .filter(({ absolute, entry }) => entry.kind === 'link' && !pointed.has(onDiskPath(absolute)) && !planned.has(onDiskPath(absolute)))
    .map(({ file, absolute }) => ({ relative: file, target: realpathOfExisting(absolute) }));
  return { writes, fallbacks, links, obstacles };
}

/**
 * Appends the planned lines, and each fallback whose imported file did not
 * get its line. A failed write is returned with its error instead of thrown:
 * a read-only instructions file is no reason to stop a scaffold that is half
 * written.
 */
export function writeAgentInstructions(plan: InstructionsPlan): InstructionsOutcome[] {
  const attempt = (write: InstructionsWrite): InstructionsOutcome => {
    try {
      appendFileSync(write.absolute, write.appended);
      return { write, error: undefined };
    } catch (cause) {
      return { write, error: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  const outcomes = plan.writes.map(attempt);
  const failed = new Set(outcomes.filter((outcome) => outcome.error !== undefined).map((outcome) => outcome.write.relative));
  return [...outcomes, ...plan.fallbacks.filter((fallback) => failed.has(fallback.after)).map(attempt)];
}

function skillFile(skillDir: string): string {
  return `${skillDir}/${SKILL_NAME}/SKILL.md`;
}

/** A character that continues a path, so a mention next to one is part of a longer path. */
const PATH_CHARACTER = /[\w.~/\\-]/u;

/**
 * Whether `content` names one of the skill files `mentions`, project-relative
 * paths, as a whole path: `./` or the project's absolute path in front still
 * names it, and `apps/admin/` in front names another project's.
 */
function namesSkillFile(cwd: string, content: string, mentions: readonly string[]): boolean {
  return mentions.some((mention) => {
    const target = onDiskPath(path.join(cwd, mention));
    for (let at = content.indexOf(mention); at !== -1; at = content.indexOf(mention, at + 1)) {
      if (/^(?:[\w/\\-]|\.\w)/u.test(content.slice(at + mention.length, at + mention.length + 2))) continue;
      let start = at;
      while (start > 0 && PATH_CHARACTER.test(content.charAt(start - 1))) start -= 1;
      if (onDiskPath(path.resolve(cwd, content.slice(start, at + mention.length))) === target) return true;
    }
    return false;
  });
}

/**
 * On-disk paths of the files `content` pulls in with a Claude Code import, a
 * line that is only `@path`. Fenced code blocks are skipped, as Claude Code
 * imports nothing from them.
 */
function importedFiles(cwd: string, content: string): string[] {
  const imported: string[] = [];
  let fence: string | undefined;
  for (const line of content.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker.startsWith(fence) && line.trim() === marker) fence = undefined;
      continue;
    }
    if (marker !== undefined) {
      fence = marker;
      continue;
    }
    const target = /^@(\S+)[ \t]*$/u.exec(line)?.[1];
    if (target !== undefined) imported.push(onDiskPath(path.resolve(cwd, target)));
  }
  return imported;
}

/** What to append so `line` is the last paragraph of `content`, in the file's line endings. */
function appendedLine(content: string, line: string): string {
  if (content === '') return `${line}\n`;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const gap = /\n\r?\n$/u.test(content) ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`;
  return `${gap}${line}${eol}`;
}

function encode(text: string, encoding: Encoding): Buffer {
  return encoding === 'utf16be' ? Buffer.from(text, 'utf16le').swap16() : Buffer.from(text, encoding);
}

/** What is at `absolute`, read only when it is, or links to, a regular file: reading a named pipe would block. */
function inspect(absolute: string): InstructionsEntry {
  const entry = lstatOrUndefined(absolute);
  if (entry === undefined) return { kind: 'missing' };
  if (entry.isSymbolicLink()) {
    const read = isFile(absolute) ? readText(absolute) : undefined;
    return { kind: 'link', text: read !== undefined && 'content' in read ? read : undefined };
  }
  if (!entry.isFile()) return { kind: 'obstacle', reason: 'not a file' };
  const read = readText(absolute);
  return 'content' in read ? { kind: 'file', text: read } : { kind: 'obstacle', reason: read.reason };
}

/**
 * The file's text in the encoding its byte order mark names, UTF-8 without
 * one, or why init cannot append to it. Bytes that are not valid UTF-8 are
 * read for the pointer only and stay as they are.
 */
function readText(absolute: string): InstructionsText | { readonly reason: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolute);
  } catch {
    return { reason: 'unreadable' };
  }
  if (bytes.length >= 4 && (bytes.readUInt32LE(0) === 0xfeff || bytes.readUInt32BE(0) === 0xfeff)) return { reason: 'UTF-32' };
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf16be' : 'utf8';
  if (encoding === 'utf8') return { content: bytes.toString('utf8').replace(/^\uFEFF/u, ''), encoding };
  if (bytes.length % 2 !== 0) return { reason: 'not valid UTF-16' };
  const units = encoding === 'utf16be' ? Buffer.from(bytes.subarray(2)).swap16() : bytes.subarray(2);
  return { content: units.toString('utf16le'), encoding };
}

/** True when `target` is a regular file, following a final symlink. */
function isFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** The entry at `target` without following a final symlink; undefined when missing or unreachable. */
function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}
