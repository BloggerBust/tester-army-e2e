import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guide } from '../../src/cli/guide.ts';
import { readGuide } from '../../src/cli/skill.ts';

const RUNNING = '0.24.0';
let dir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-guide-version-'));
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((stdout += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((stderr += String(chunk)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function declare(spec: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { e2e: spec }, ...extra }));
}

/** An installed e2e whose guide says which version wrote it; `skill: false` for a release from before the skill shipped. */
function install(version: string, skill = true, root = dir): void {
  const packageDir = path.join(root, 'node_modules', 'e2e');
  mkdirSync(path.join(packageDir, 'skills', 'e2e', 'references'), { recursive: true });
  writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'e2e', version }));
  if (!skill) return;
  writeFileSync(path.join(packageDir, 'skills', 'e2e', 'SKILL.md'), `---\nname: e2e\n---\n\n# overview of ${version}\n`);
  writeFileSync(path.join(packageDir, 'skills', 'e2e', 'references', 'only-here.md'), `# topic of ${version}\n`);
}

function run(topic?: string, cwd = dir): number {
  return guide(topic, { version: RUNNING, cwd, env: {} });
}

describe('e2e guide and the version the project uses', () => {
  it('prints its own guide and names its version outside a project', () => {
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe(`Guide for e2e ${RUNNING}\n`);
  });

  it.each(['0.24.0', '^0.24.0', '^0.24', '0.x', '*', '>=0.23.0 <1', '>= 0.23.0', '^0.23.0 || ^0.24.0', '0.23 - 0.24', 'latest', 'workspace:*', 'catalog:', 'npm:e2e@0.23.0', 'github:e2e-inc/e2e'])('adds nothing when package.json declares %s', (spec) => {
    declare(spec);
    expect(run('setup')).toBe(0);
    expect(stdout).toBe(readGuide('setup'));
    expect(stderr).toBe(`Guide for e2e ${RUNNING}\n`);
  });

  it('names both versions and the matching commands when the declared version is not installed', () => {
    declare('0.23.0');
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe(
      'Guide for e2e 0.24.0, but package.json declares e2e 0.23.0 and no installed copy was found. For the matching guide, run `npm install` and then `npm exec -- e2e guide`, or run `npx e2e@0.23.0 guide`.\n',
    );
  });

  it('says what a declared range installs and uses the project package manager, from a subdirectory too', () => {
    declare('^0.23.0', { packageManager: 'pnpm@10.0.0' });
    mkdirSync(path.join(dir, 'tests'));
    expect(run(undefined, path.join(dir, 'tests'))).toBe(0);
    expect(stderr).toBe(
      `Guide for e2e 0.24.0, but ${path.join('..', 'package.json')} declares e2e ^0.23.0 and no installed copy was found. For the guide of the version the project installs, run \`pnpm install\` and then \`pnpm exec e2e guide\`; \`npx "e2e@^0.23.0" guide\` prints the newest release in that range, which may not be the one the lockfile pins.\n`,
    );
  });

  it.each(['^0.23', '~0.23', '0.23', '0.23.x', '^0.22.0 || ^0.23.0', '>= 0.22.0 < 0.24.0', '<0.24', '0.22 - 0.23', '^0.25'])(
    'names the range %s, which npm reads as leaving this version out',
    (spec) => {
      declare(spec);
      expect(run()).toBe(0);
      expect(stdout).toBe(readGuide(undefined));
      expect(stderr).toContain(`Guide for e2e 0.24.0, but package.json declares e2e ${spec} and no installed copy was found.`);
      expect(stderr).toContain(`\`npx "e2e@${spec}" guide\``);
    },
  );

  it('holds a prerelease CLI to the range as npm does', () => {
    declare('^0.24.0');
    expect(guide(undefined, { version: '0.24.1-nightly-20261019081103', cwd: dir, env: {} })).toBe(0);
    expect(stderr).toContain('Guide for e2e 0.24.1-nightly-20261019081103, but package.json declares e2e ^0.24.0 and no installed copy was found.');
  });

  it("prints the installed copy's guide and topics when it is another version", () => {
    declare('^0.23.0');
    install('0.23.1');
    expect(run()).toBe(0);
    expect(stdout).toBe('# overview of 0.23.1\n');
    expect(stderr).toBe('Guide for e2e 0.23.1, the version installed in this project (this CLI is e2e 0.24.0)\n');
    stdout = '';
    expect(run('only-here')).toBe(0);
    expect(stdout).toBe('# topic of 0.23.1\n');
    stderr = '';
    expect(run('setup')).toBe(2);
    expect(stderr).toBe('Guide for e2e 0.23.1, the version installed in this project (this CLI is e2e 0.24.0)\nunknown topic "setup"; topics: only-here\n');
  });

  it('says when the installed copy is behind what package.json declares', () => {
    declare('^0.25.0');
    install(RUNNING);
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe(
      'Guide for e2e 0.24.0, but package.json declares e2e ^0.25.0, which the installed e2e 0.24.0 is outside of; run `npm install` for the matching guide\n',
    );
  });

  it('keeps its own guide when package.json declares its version and the installed copy is a stale one', () => {
    declare('^0.24.0');
    install('0.20.0');
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe('Guide for e2e 0.24.0. package.json declares e2e ^0.24.0, which the installed e2e 0.20.0 is outside of; run `npm install`\n');
  });

  it("prints the installed copy's guide and says so when it is outside the declared range and so is this CLI", () => {
    declare('^0.25.0');
    install('0.23.1');
    expect(run()).toBe(0);
    expect(stdout).toBe('# overview of 0.23.1\n');
    expect(stderr).toBe(
      'Guide for e2e 0.23.1, the version installed in this project (this CLI is e2e 0.24.0). package.json declares e2e ^0.25.0, which the installed e2e 0.23.1 is outside of; run `npm install` for the matching guide\n',
    );
  });

  it('reads the copy a workspace hoists to its root, for a member that declares e2e', () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    const member = path.join(dir, 'apps', 'web');
    mkdirSync(member, { recursive: true });
    writeFileSync(path.join(member, 'package.json'), JSON.stringify({ devDependencies: { e2e: '^0.23.0' } }));
    install('0.23.1');
    expect(run(undefined, member)).toBe(0);
    expect(stdout).toBe('# overview of 0.23.1\n');
    expect(stderr).toBe('Guide for e2e 0.23.1, the version installed in this project (this CLI is e2e 0.24.0)\n');
  });

  it("prefers a member's own copy to the one hoisted above it", () => {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }));
    const member = path.join(dir, 'apps', 'web');
    mkdirSync(member, { recursive: true });
    writeFileSync(path.join(member, 'package.json'), JSON.stringify({ devDependencies: { e2e: '^0.22.0' } }));
    install('0.23.1');
    install('0.22.4', true, member);
    expect(run(undefined, member)).toBe(0);
    expect(stdout).toBe('# overview of 0.22.4\n');
  });

  it("prints an installed prerelease's guide when package.json pins it", () => {
    declare('0.24.1-nightly-20261019081103');
    install('0.24.1-nightly-20261019081103');
    expect(run()).toBe(0);
    expect(stdout).toBe('# overview of 0.24.1-nightly-20261019081103\n');
    expect(stderr).toBe('Guide for e2e 0.24.1-nightly-20261019081103, the version installed in this project (this CLI is e2e 0.24.0)\n');
  });

  it('says when an installed prerelease is outside a range of releases', () => {
    declare('^0.24.0');
    install('0.24.1-nightly-20261019081103');
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe(
      'Guide for e2e 0.24.0. package.json declares e2e ^0.24.0, which the installed e2e 0.24.1-nightly-20261019081103 is outside of; run `npm install`\n',
    );
  });

  it("prints an installed copy's guide in a directory with no package.json", () => {
    install('0.23.1');
    expect(run()).toBe(0);
    expect(stdout).toBe('# overview of 0.23.1\n');
  });

  it('says so when the installed version ships no guide', () => {
    declare('0.10.0');
    install('0.10.0', false);
    expect(run()).toBe(0);
    expect(stdout).toBe(readGuide(undefined));
    expect(stderr).toBe("Guide for e2e 0.24.0; the project's installed e2e 0.10.0 ships no guide\n");
  });

  describe('when sections of package.json give different specs', () => {
    const INSTALLED_GUIDE = 'Guide for e2e 0.23.1, the version installed in this project (this CLI is e2e 0.24.0)\n';
    const reinstall = (spec: string, manager: string): string =>
      `Guide for e2e 0.24.0. package.json declares e2e ${spec}, which the installed e2e 0.23.1 is outside of; run \`${manager} install\`\n`;

    function sections(manager: string, specs: { dependencies?: string; devDependencies?: string; optionalDependencies?: string }): void {
      const entries = Object.entries(specs).map(([section, spec]) => [section, { e2e: spec }]);
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ packageManager: `${manager}@1.0.0`, ...Object.fromEntries(entries) }));
    }

    it.each(['npm', 'pnpm', 'yarn', 'bun'])('%s installs from optionalDependencies over dependencies', (manager) => {
      sections(manager, { dependencies: '^0.24.0', optionalDependencies: '^0.23.0' });
      install('0.23.1');
      expect(run()).toBe(0);
      expect(stdout).toBe('# overview of 0.23.1\n');
      expect(stderr).toBe(INSTALLED_GUIDE);
    });

    it.each(['npm', 'pnpm', 'yarn', 'bun'])('%s is told to reinstall when optionalDependencies has moved on', (manager) => {
      sections(manager, { dependencies: '^0.23.0', optionalDependencies: '^0.24.0' });
      install('0.23.1');
      expect(run()).toBe(0);
      expect(stdout).toBe(readGuide(undefined));
      expect(stderr).toBe(reinstall('^0.24.0', manager));
    });

    it.each([
      ['npm', { dependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['npm', { optionalDependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['npm', { dependencies: '^0.24.0', optionalDependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['pnpm', { dependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['pnpm', { optionalDependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['pnpm', { dependencies: '^0.24.0', optionalDependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['bun', { dependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['bun', { optionalDependencies: '^0.23.0', devDependencies: '^0.24.0' }],
    ] as const)('%s installs 0.23.1 from %o', (manager, specs) => {
      sections(manager, specs);
      install('0.23.1');
      expect(run()).toBe(0);
      expect(stdout).toBe('# overview of 0.23.1\n');
      expect(stderr).toBe(INSTALLED_GUIDE);
    });

    it.each([
      ['npm', { dependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['npm', { optionalDependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['pnpm', { dependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['pnpm', { optionalDependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['bun', { dependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['bun', { optionalDependencies: '^0.24.0', devDependencies: '^0.23.0' }],
    ] as const)('%s is told to reinstall 0.23.1 for %o', (manager, specs) => {
      sections(manager, specs);
      install('0.23.1');
      expect(run()).toBe(0);
      expect(stdout).toBe(readGuide(undefined));
      expect(stderr).toBe(reinstall('^0.24.0', manager));
    });

    // Yarn 1 and Yarn 2 and later pick opposite sections, and so do Bun releases given all three.
    it.each([
      ['yarn', { dependencies: '^0.24.0', devDependencies: '^0.23.0' }],
      ['yarn', { optionalDependencies: '^0.23.0', devDependencies: '^0.24.0' }],
      ['bun', { dependencies: '^0.23.0', optionalDependencies: '^0.24.0', devDependencies: '^0.23.0' }],
    ] as const)('%s gets the installed guide and no advice for %o', (manager, specs) => {
      sections(manager, specs);
      install('0.23.1');
      expect(run()).toBe(0);
      expect(stdout).toBe('# overview of 0.23.1\n');
      expect(stderr).toBe(INSTALLED_GUIDE);
      rmSync(path.join(dir, 'node_modules'), { recursive: true });
      stderr = '';
      expect(run()).toBe(0);
      expect(stderr).toBe(`Guide for e2e ${RUNNING}\n`);
    });

    it('reads sections that agree as one spec', () => {
      sections('yarn', { dependencies: '^0.23.0', devDependencies: '^0.23.0' });
      expect(run()).toBe(0);
      expect(stderr).toContain('but package.json declares e2e ^0.23.0 and no installed copy was found');
    });
  });
});
