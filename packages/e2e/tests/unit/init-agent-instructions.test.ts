import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planAgentInstructions, writeAgentInstructions } from '../../src/cli/init/agent-instructions.ts';

const BOTH = ['.agents/skills', '.claude/skills'];
const AGENTS_LINE = 'End-to-end tests use e2e; read .agents/skills/e2e/SKILL.md before writing or running one.';
const CLAUDE_LINE = 'End-to-end tests use e2e; read .claude/skills/e2e/SKILL.md before writing or running one.';

const NOTHING = { writes: [], fallbacks: [], links: [], obstacles: [] };

/** Whether this host lets the tests create symlinks; Windows needs a privilege for them. */
const symlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-symlink-'));
  try {
    writeFileSync(path.join(probe, 'file'), '');
    symlinkSync(path.join(probe, 'file'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/** A read-only file stops nobody as root, and Windows has no such mode. */
const modes = process.platform !== 'win32' && process.getuid?.() !== 0;

let dir: string;

/** Puts a skill file where an earlier init, or this run's install, leaves it. */
function installSkill(...locations: string[]): void {
  for (const location of locations) {
    mkdirSync(path.join(dir, location, 'e2e'), { recursive: true });
    writeFileSync(path.join(dir, location, 'e2e', 'SKILL.md'), '# e2e\n');
  }
}

function write(file: string, content: string): void {
  writeFileSync(path.join(dir, file), content);
}

/** Plans for `skillDirs` and applies the writes, as init does after the confirmation. */
function run(skillDirs: readonly string[] = BOTH): ReturnType<typeof planAgentInstructions> {
  const plan = planAgentInstructions(dir, skillDirs, []);
  writeAgentInstructions(plan);
  return plan;
}

function read(file: string): string {
  return readFileSync(path.join(dir, file), 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-init-instructions-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('planAgentInstructions', () => {
  it('creates each file with the line for its own skills directory', () => {
    installSkill(...BOTH);
    expect(run().writes.map(({ relative, existing }) => ({ relative, existing }))).toEqual([
      { relative: 'AGENTS.md', existing: false },
      { relative: 'CLAUDE.md', existing: false },
    ]);
    expect(read('AGENTS.md')).toBe(`${AGENTS_LINE}\n`);
    expect(read('CLAUDE.md')).toBe(`${CLAUDE_LINE}\n`);
  });

  it('plans a directory whose skill this run installs, before it is on disk', () => {
    const going = [{ kind: 'link' as const, relative: '.claude/skills/e2e', existing: false, target: '../../.agents/skills/e2e', links: [], obstacles: [] }];
    expect(planAgentInstructions(dir, BOTH, going).writes.map((planned) => planned.relative)).toEqual(['CLAUDE.md']);
  });

  it('writes only the file of a directory that holds the skill', () => {
    installSkill('.claude/skills');
    expect(run(['.claude/skills']).writes.map((planned) => planned.relative)).toEqual(['CLAUDE.md']);
    expect(read('CLAUDE.md')).toBe(`${CLAUDE_LINE}\n`);
  });

  it('writes nothing for a skill whose SKILL.md is a directory', () => {
    mkdirSync(path.join(dir, '.agents/skills/e2e/SKILL.md'), { recursive: true });
    expect(run(['.agents/skills'])).toEqual(NOTHING);
    expect(existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
  });

  it.skipIf(!symlinks)('plans a directory whose link leads to a copy this run installs', () => {
    mkdirSync(path.join(dir, '.claude/skills'), { recursive: true });
    symlinkSync('../../.agents/skills/e2e', path.join(dir, '.claude/skills/e2e'));
    const going = [{ kind: 'copy' as const, relative: '.agents/skills/e2e', existing: false, files: [], retired: [], links: [], obstacles: [] }];
    expect(planAgentInstructions(dir, BOTH, going).writes.map((planned) => planned.relative)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('writes nothing without a chosen directory, or when the chosen one holds no skill', () => {
    installSkill('.agents/skills');
    expect(run([])).toEqual(NOTHING);
    expect(run(['.claude/skills'])).toEqual(NOTHING);
  });

  it.each([
    ['no trailing newline', '# Project\n\nUse pnpm.', `# Project\n\nUse pnpm.\n\n${AGENTS_LINE}\n`],
    ['a trailing newline', '# Project\n', `# Project\n\n${AGENTS_LINE}\n`],
    ['a trailing blank line', '# Project\n\n', `# Project\n\n${AGENTS_LINE}\n`],
    ['CRLF line endings', '# Project\r\nUse pnpm.\r\n', `# Project\r\nUse pnpm.\r\n\r\n${AGENTS_LINE}\r\n`],
    ['no content', '', `${AGENTS_LINE}\n`],
  ])('appends the line as its own paragraph to a file with %s', (_name, before, after) => {
    installSkill('.agents/skills');
    write('AGENTS.md', before);
    expect(run(['.agents/skills']).writes).toMatchObject([{ relative: 'AGENTS.md', existing: true }]);
    expect(read('AGENTS.md')).toBe(after);
  });

  it('plans nothing on a second run', () => {
    installSkill(...BOTH);
    write('AGENTS.md', '# Project\n');
    run();
    const first = [read('AGENTS.md'), read('CLAUDE.md')];
    expect(run()).toEqual(NOTHING);
    expect([read('AGENTS.md'), read('CLAUDE.md')]).toEqual(first);
  });

  it('leaves a file that names the other installed skill file', () => {
    installSkill(...BOTH);
    write('CLAUDE.md', `# Project\n\nRead .agents/skills/e2e/SKILL.md for tests.\n`);
    expect(run().writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
  });

  it.each([
    ['./.agents/skills/e2e/SKILL.md', true],
    ['@.agents/skills/e2e/SKILL.md', true],
    ['[the skill](.agents/skills/e2e/SKILL.md).', true],
    ['apps/admin/.agents/skills/e2e/SKILL.md', false],
    ['.agents/skills/e2e/SKILL.md.bak', false],
    ['.agents/skills/e2e/SKILL.mdx', false],
  ])('reads %j as naming the skill file: %j', (mention, names) => {
    installSkill('.agents/skills');
    write('AGENTS.md', `Read ${mention}\n`);
    expect(run(['.agents/skills']).writes.map((planned) => planned.relative)).toEqual(names ? [] : ['AGENTS.md']);
  });

  it('reads the absolute path of the skill file as naming it, and not another project\'s', () => {
    installSkill('.agents/skills');
    write('AGENTS.md', `Read ${path.join(dir, '.agents/skills/e2e/SKILL.md')}\n`);
    expect(run(['.agents/skills'])).toEqual(NOTHING);
    write('AGENTS.md', `Read ${path.join(dir, 'apps/admin/.agents/skills/e2e/SKILL.md')}\n`);
    expect(run(['.agents/skills']).writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
  });

  it('appends to a file that names only a skill file that is not installed', () => {
    installSkill('.claude/skills');
    write('CLAUDE.md', 'Read .agents/skills/e2e/SKILL.md for tests.\n');
    run(['.claude/skills']);
    expect(read('CLAUDE.md')).toBe(`Read .agents/skills/e2e/SKILL.md for tests.\n\n${CLAUDE_LINE}\n`);
  });

  it.skipIf(!symlinks)('writes once through AGENTS.md when CLAUDE.md is a symlink to it', () => {
    installSkill(...BOTH);
    write('AGENTS.md', '# Project\n');
    symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
    expect(run()).toMatchObject({ writes: [{ relative: 'AGENTS.md' }], links: [] });
    expect(read('CLAUDE.md')).toBe(`# Project\n\n${AGENTS_LINE}\n`);
    expect(run()).toEqual(NOTHING);
  });

  it.skipIf(!symlinks)('reports a symlink that leads to a file without the line', () => {
    installSkill('.claude/skills');
    write('AGENTS.md', '# Project\n');
    symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
    const plan = run(['.claude/skills']);
    expect(plan.writes).toEqual([]);
    expect(plan.links).toMatchObject([{ relative: 'CLAUDE.md' }]);
    expect(plan.links[0]?.target.endsWith(`${path.sep}AGENTS.md`)).toBe(true);
    expect(read('AGENTS.md')).toBe('# Project\n');
  });

  it.each(['@AGENTS.md\n', '# Claude\n\n@./AGENTS.md\r\n\r\nUse pnpm.\r\n'])('leaves a CLAUDE.md that imports AGENTS.md: %j', (content) => {
    installSkill(...BOTH);
    write('CLAUDE.md', content);
    expect(run().writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
    expect(read('CLAUDE.md')).toBe(content);
  });

  it.each([
    ['inside a sentence', 'See @AGENTS.md for rules.\n'],
    ['at the end of a sentence', 'The rules are in @AGENTS.md\n'],
    ['in a fenced code block', '```md\n@AGENTS.md\n```\n'],
    ['in a tilde fence that holds a shorter one', '~~~~\n~~~\n@AGENTS.md\n~~~~\n'],
    ['in a fence left open', '# Claude\n\n```\n@AGENTS.md\n'],
  ])('appends to a CLAUDE.md with @AGENTS.md %s, which is no import', (_name, content) => {
    installSkill(...BOTH);
    write('CLAUDE.md', content);
    expect(run().writes.map((planned) => planned.relative)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(read('CLAUDE.md').endsWith(`\n\n${CLAUDE_LINE}\n`)).toBe(true);
  });

  it('reads an import after a closed fence', () => {
    installSkill(...BOTH);
    write('CLAUDE.md', '```sh\npnpm test\n```\n@AGENTS.md\n');
    expect(run().writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
  });

  it.skipIf(!modes)('gives an importing CLAUDE.md the line when the write to AGENTS.md fails', () => {
    installSkill(...BOTH);
    write('AGENTS.md', '# Project\n');
    write('CLAUDE.md', '@AGENTS.md\n');
    chmodSync(path.join(dir, 'AGENTS.md'), 0o444);
    const plan = planAgentInstructions(dir, BOTH, []);
    expect(plan.writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
    expect(plan.fallbacks).toMatchObject([{ relative: 'CLAUDE.md', after: 'AGENTS.md' }]);
    const outcomes = writeAgentInstructions(plan);
    expect(outcomes.map(({ write: attempted, error }) => [attempted.relative, error === undefined])).toEqual([['AGENTS.md', false], ['CLAUDE.md', true]]);
    expect(outcomes[0]?.error).toContain('EACCES');
    expect(read('AGENTS.md')).toBe('# Project\n');
    expect(read('CLAUDE.md')).toBe(`@AGENTS.md\n\n${CLAUDE_LINE}\n`);
  });

  it.skipIf(!symlinks)('leaves a CLAUDE.md that imports a symlinked AGENTS.md whose target names the skill', () => {
    installSkill(...BOTH);
    write('shared.md', `# Shared\n\n${AGENTS_LINE}\n`);
    symlinkSync('shared.md', path.join(dir, 'AGENTS.md'));
    write('CLAUDE.md', '@AGENTS.md\n');
    expect(run()).toEqual(NOTHING);
    expect(read('CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it.skipIf(!symlinks || process.platform === 'win32')('reports a symlink to a named pipe without reading it', () => {
    installSkill('.agents/skills');
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    symlinkSync('pipe', path.join(dir, 'AGENTS.md'));
    // In a child, so a read that blocks on the pipe fails here instead of hanging the suite.
    const planner = new URL('../../src/cli/init/agent-instructions.ts', import.meta.url).href;
    const script = `import { planAgentInstructions } from ${JSON.stringify(planner)};
      console.log(JSON.stringify(planAgentInstructions(${JSON.stringify(dir)}, ['.agents/skills'], [])));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    expect(child.signal).toBeNull();
    expect(JSON.parse(child.stdout)).toEqual({ ...NOTHING, links: [{ relative: 'AGENTS.md', target: path.join(realpathSync(dir), 'pipe') }] });
  });

  it('appends to a CLAUDE.md whose import is not a file with the line', () => {
    installSkill('.claude/skills');
    write('AGENTS.md', '# Project\n');
    write('CLAUDE.md', '@AGENTS.md\n');
    run(['.claude/skills']);
    expect(read('CLAUDE.md')).toBe(`@AGENTS.md\n\n${CLAUDE_LINE}\n`);
    expect(read('AGENTS.md')).toBe('# Project\n');
  });

  it.skipIf(!symlinks)('stays quiet about a symlink whose target already names the skill', () => {
    installSkill('.agents/skills');
    write('shared.md', `# Shared\n\n${AGENTS_LINE}\n`);
    symlinkSync('shared.md', path.join(dir, 'AGENTS.md'));
    expect(run(['.agents/skills'])).toEqual(NOTHING);
  });

  it.skipIf(!symlinks)('writes once through CLAUDE.md when AGENTS.md is a symlink to it', () => {
    installSkill(...BOTH);
    write('CLAUDE.md', '# Project\n');
    symlinkSync('CLAUDE.md', path.join(dir, 'AGENTS.md'));
    expect(run()).toMatchObject({ writes: [{ relative: 'CLAUDE.md' }], links: [] });
    expect(read('AGENTS.md')).toBe(`# Project\n\n${CLAUDE_LINE}\n`);
    expect(run()).toEqual(NOTHING);
  });

  it('keeps the bytes of a file that is not UTF-8', () => {
    installSkill('.agents/skills');
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    writeFileSync(path.join(dir, 'AGENTS.md'), latin1);
    run(['.agents/skills']);
    expect(readFileSync(path.join(dir, 'AGENTS.md')).subarray(0, latin1.length)).toEqual(latin1);
    expect(read('AGENTS.md').endsWith(`\n\n${AGENTS_LINE}\n`)).toBe(true);
  });

  it.each([
    ['UTF-16LE', (text: string) => Buffer.from(`\uFEFF${text}`, 'utf16le')],
    ['UTF-16BE', (text: string) => Buffer.from(`\uFEFF${text}`, 'utf16le').swap16()],
  ])('appends to a %s file in its encoding', (_name, encode) => {
    installSkill('.agents/skills');
    writeFileSync(path.join(dir, 'AGENTS.md'), encode('# Project\r\n'));
    expect(run(['.agents/skills']).writes).toMatchObject([{ relative: 'AGENTS.md', existing: true }]);
    expect(readFileSync(path.join(dir, 'AGENTS.md'))).toEqual(encode(`# Project\r\n\r\n${AGENTS_LINE}\r\n`));
    expect(run(['.agents/skills'])).toEqual(NOTHING);
  });

  it.each([
    ['UTF-32', Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00]), 'UTF-32'],
    ['UTF-16 with half a code unit', Buffer.from([0xff, 0xfe, 0x23, 0x00, 0x0a]), 'not valid UTF-16'],
  ])('names a %s file and leaves its bytes', (_name, bytes, reason) => {
    installSkill('.agents/skills');
    writeFileSync(path.join(dir, 'AGENTS.md'), bytes);
    expect(run(['.agents/skills'])).toEqual({ ...NOTHING, obstacles: [{ relative: 'AGENTS.md', reason }] });
    expect(readFileSync(path.join(dir, 'AGENTS.md'))).toEqual(bytes);
  });

  it('reads an import behind a UTF-8 byte order mark', () => {
    installSkill(...BOTH);
    write('CLAUDE.md', '\uFEFF@AGENTS.md\n');
    expect(run().writes.map((planned) => planned.relative)).toEqual(['AGENTS.md']);
  });

  it.skipIf(!modes)('names a file it cannot read', () => {
    installSkill('.agents/skills');
    write('AGENTS.md', '# Project\n');
    chmodSync(path.join(dir, 'AGENTS.md'), 0o000);
    expect(run(['.agents/skills'])).toEqual({ ...NOTHING, obstacles: [{ relative: 'AGENTS.md', reason: 'unreadable' }] });
  });

  it('names a directory where the file goes', () => {
    installSkill('.agents/skills');
    mkdirSync(path.join(dir, 'AGENTS.md'));
    expect(run(['.agents/skills'])).toEqual({ ...NOTHING, obstacles: [{ relative: 'AGENTS.md', reason: 'not a file' }] });
  });
});
