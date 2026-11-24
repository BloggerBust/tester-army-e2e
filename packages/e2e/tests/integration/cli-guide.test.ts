import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = path.join(PACKAGE_ROOT, 'dist', 'cli', 'bin.js');
const REPO_SKILL = path.join(PACKAGE_ROOT, '..', '..', 'skills', 'e2e');
const { version: VERSION } = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-guide-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the built CLI and the bundled skill', () => {
  it('prints the overview and a topic from the package copy of the skill', async () => {
    const overview = await execFileAsync(process.execPath, [CLI, 'guide'], { cwd: dir });
    expect(overview.stdout.startsWith('# e2e')).toBe(true);
    const topic = await execFileAsync(process.execPath, [CLI, 'guide', 'writing-tests'], { cwd: dir });
    expect(topic.stdout).toBe(readFileSync(path.join(REPO_SKILL, 'references', 'writing-tests.md'), 'utf8'));
    await expect(execFileAsync(process.execPath, [CLI, 'guide', 'nope'], { cwd: dir })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('unknown topic "nope"; topics: agent, bug-bash, debugging, explore, mcp, running, setup, writing-tests'),
    });
    const help = await execFileAsync(process.execPath, [CLI, '--help'], { cwd: dir });
    expect(help.stdout).toContain('guide [topic]');
    const guideHelp = await execFileAsync(process.execPath, [CLI, 'guide', '--help'], { cwd: dir });
    expect(guideHelp.stdout).toContain('Topics: agent, bug-bash, debugging, explore, mcp, running, setup, writing-tests\n');
  });

  it('names its own version on stderr and keeps stdout the guide alone', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'guide', 'setup'], { cwd: dir });
    expect(stderr).toBe(`Guide for e2e ${VERSION}\n`);
    expect(stdout).toBe(readFileSync(path.join(REPO_SKILL, 'references', 'setup.md'), 'utf8'));
  });

  it('says so when package.json declares a partial range that leaves it out', async () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: '^0.1' } }));
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'guide', 'setup'], { cwd: dir, env: { ...process.env, npm_config_user_agent: '' } });
    expect(stderr).toBe(
      `Guide for e2e ${VERSION}, but package.json declares e2e ^0.1 and no installed copy was found. For the guide of the version the project installs, run \`npm install\` and then \`npm exec -- e2e guide\`; \`npx "e2e@^0.1" guide\` prints the newest release in that range, which may not be the one the lockfile pins.\n`,
    );
    expect(stdout).toBe(readFileSync(path.join(REPO_SKILL, 'references', 'setup.md'), 'utf8'));
  });

  it("prints an installed copy's guide and lists its topics in help", async () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { e2e: '^9.0.0' }, optionalDependencies: { e2e: '^0.1.0' } }));
    const skill = path.join(dir, 'node_modules', 'e2e', 'skills', 'e2e');
    mkdirSync(path.join(skill, 'references'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'e2e', 'package.json'), JSON.stringify({ name: 'e2e', version: '0.1.5' }));
    writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: e2e\n---\n\n# overview of 0.1.5\n');
    writeFileSync(path.join(skill, 'references', 'only-here.md'), '# topic of 0.1.5\n');
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, 'guide'], { cwd: dir });
    expect(stderr).toBe(`Guide for e2e 0.1.5, the version installed in this project (this CLI is e2e ${VERSION})\n`);
    expect(stdout).toBe('# overview of 0.1.5\n');
    const help = await execFileAsync(process.execPath, [CLI, 'guide', '--help'], { cwd: dir });
    expect(help.stdout).toContain('Topics: only-here\n');
  });

  it('installs the skill into both agent directories with init --yes', async () => {
    await execFileAsync(process.execPath, [CLI, 'init', '--yes'], { cwd: dir });
    for (const location of ['.agents/skills', '.claude/skills']) {
      const skill = path.join(dir, location, 'e2e', 'SKILL.md');
      expect(existsSync(skill), skill).toBe(true);
      expect(readFileSync(skill, 'utf8')).toBe(readFileSync(path.join(REPO_SKILL, 'SKILL.md'), 'utf8'));
      expect(existsSync(path.join(dir, location, 'e2e', 'references', 'setup.md'))).toBe(true);
    }
  });

  it('packs the skill files with the package', async () => {
    const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: PACKAGE_ROOT });
    const [tarball] = JSON.parse(stdout) as { files: { path: string }[] }[];
    const packed = tarball?.files.map((file) => file.path) ?? [];
    expect(packed).toContain('skills/e2e/SKILL.md');
    expect(packed).toContain('skills/e2e/references/writing-tests.md');
    expect(packed).toContain('dist/cli/skill.js');
    expect(packed).toContain('README.md');
  });

  it('ships the repository README with its relative links pointing at GitHub', () => {
    const readme = readFileSync(path.join(PACKAGE_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('src="https://raw.githubusercontent.com/e2e-inc/e2e/main/.github/assets/readme-banner.png"');
    expect(readme).not.toMatch(/(src="|href="|\]\()\.\//);
    const relative = readme
      .replaceAll('https://raw.githubusercontent.com/e2e-inc/e2e/main/', './')
      .replaceAll('https://github.com/e2e-inc/e2e/blob/main/', './');
    expect(relative).toBe(readFileSync(path.join(PACKAGE_ROOT, '..', '..', 'README.md'), 'utf8'));
  });
});
