import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addDevDependencyCommand,
  detectPackageManager,
  detectWorkspacePackageManager,
  execCommand,
  installCommand,
  runScriptCommand,
  type PackageManager,
} from '../../src/internal/package-manager.ts';

/** Mirrors cli-init.test.ts: Windows needs special privileges for symlinks. */
const symlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'e2e-pm-symlink-'));
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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-pm-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('detectPackageManager', () => {
  it('prefers the packageManager field, then a lockfile, then the invoking manager, then npm', () => {
    expect(detectPackageManager(dir, 'pnpm@10.0.0', {})).toBe('pnpm');
    expect(detectPackageManager(dir, 'unknown@1', {})).toBe('npm');
    writeFileSync(path.join(dir, 'yarn.lock'), '');
    expect(detectPackageManager(dir, undefined, {})).toBe('yarn');
    rmSync(path.join(dir, 'yarn.lock'));
    expect(detectPackageManager(dir, undefined, { npm_config_user_agent: 'bun/1.2.0' })).toBe('bun');
    expect(detectPackageManager(dir, undefined, { npm_config_user_agent: 'cargo/1' })).toBe('npm');
    expect(detectPackageManager(dir, undefined, {})).toBe('npm');
  });
});

describe('lockfile type checks', () => {
  it('ignores directories named as lockfiles', () => {
    mkdirSync(path.join(dir, 'pnpm-lock.yaml'));
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    expect(detectPackageManager(dir, undefined, {})).toBe('npm');
  });

  it.skipIf(!symlinks)('retains symlinks to regular lockfiles when the host permits symlinks', () => {
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    symlinkSync('package-lock.json', path.join(dir, 'pnpm-lock.yaml'));
    expect(detectPackageManager(dir, undefined, {})).toBe('pnpm');
  });
});

describe('detectWorkspacePackageManager', () => {
  it("reads a workspace member's manager at the workspace root that lists it", () => {
    const member = path.join(dir, 'apps', 'web');
    mkdirSync(member, { recursive: true });
    writeFileSync(path.join(member, 'package.json'), '{"name":"web"}');
    expect(detectWorkspacePackageManager(member, { npm_config_user_agent: 'bun/1.2.0' }).manager).toBe('bun');
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), "# the apps\npackages:\n  - 'apps/*' # each app\n  - \"!apps/legacy\"\n\nallowBuilds:\n  - not-a-glob\n");
    expect(detectWorkspacePackageManager(member, {}).manager).toBe('pnpm');
    writeFileSync(path.join(dir, 'package.json'), '{"packageManager":"pnpm@12.3.4"}');
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectWorkspacePackageManager(member, {}).manager).toBe('pnpm');
    writeFileSync(path.join(member, 'package-lock.json'), '{}');
    expect(detectWorkspacePackageManager(member, {})).toEqual({ manager: 'npm', root: member });
    rmSync(path.join(member, 'package-lock.json'));
    expect(detectWorkspacePackageManager(member, {})).toEqual({ manager: 'pnpm', root: dir });
  });

  it('reads a pnpm workspace root with no lockfile yet as pnpm', () => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(path.join(dir, 'package.json'), '{}');
    expect(detectWorkspacePackageManager(dir, { npm_config_user_agent: 'npm/11.0.0' })).toEqual({ manager: 'pnpm', root: dir });
  });

  it.each([
    ['an unindented block list', 'packages:\n- apps/*\n- "!apps/legacy"\n'],
    ['a flow list', "packages: ['apps/*', \"!apps/legacy\"] # every app\n"],
    ['a flow list over several lines', "packages: [\n  'apps/*', # every app\n  \"!apps/legacy\",\n]\ncatalog:\n  react: ^19.0.0\n"],
  ])('reads the packages of %s', (_form, yaml) => {
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), yaml);
    const member = path.join(dir, 'apps', 'web');
    const legacy = path.join(dir, 'apps', 'legacy');
    mkdirSync(member, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    expect(detectWorkspacePackageManager(member, { npm_config_user_agent: 'npm/11.0.0' }).manager).toBe('pnpm');
    expect(detectWorkspacePackageManager(legacy, { npm_config_user_agent: 'npm/11.0.0' }).manager).toBe('npm');
  });

  it("ignores a lockfile above that belongs to a workspace the package is not in, or to no workspace", () => {
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - "!packages/legacy"\n');
    for (const relative of ['examples/with-vite', 'packages/legacy']) {
      const outside = path.join(dir, ...relative.split('/'));
      mkdirSync(outside, { recursive: true });
      expect(detectWorkspacePackageManager(outside, {}).manager).toBe('npm');
      expect(detectWorkspacePackageManager(outside, { npm_config_user_agent: 'yarn/1.22.22' }).manager).toBe('yarn');
    }
    rmSync(path.join(dir, 'pnpm-workspace.yaml'));
    expect(detectWorkspacePackageManager(path.join(dir, 'packages', 'legacy'), {}).manager).toBe('npm');
    writeFileSync(path.join(dir, 'package.json'), '{"workspaces":{"packages":["packages/**"]}}');
    rmSync(path.join(dir, 'pnpm-lock.yaml'));
    writeFileSync(path.join(dir, 'bun.lock'), '');
    expect(detectWorkspacePackageManager(path.join(dir, 'packages', 'legacy'), {}).manager).toBe('bun');
  });
});

describe('manager commands', () => {
  it('spells the script run, the binary exec, and the dev dependency add for each manager', () => {
    expect((['npm', 'pnpm', 'yarn', 'bun'] as const satisfies readonly PackageManager[]).map((manager) => [
      runScriptCommand(manager, 'test:e2e'),
      execCommand(manager, 'e2e guide'),
      addDevDependencyCommand(manager, 'ai'),
    ])).toEqual([
      ['npm run test:e2e', 'npm exec -- e2e guide', 'npm install --save-dev ai'],
      ['pnpm test:e2e', 'pnpm exec e2e guide', 'pnpm add -D ai'],
      ['yarn test:e2e', 'yarn e2e guide', 'yarn add -D ai'],
      ['bun run test:e2e', 'bun run e2e guide', 'bun add -d ai'],
    ]);
  });

  it.each([
    ['npm', ['install']],
    ['pnpm', ['install', '--no-frozen-lockfile']],
    ['yarn', ['install']],
    ['bun', ['install']],
  ] as const)('installs with %s so that the lockfile can change in CI', (manager, args) => {
    expect(installCommand(manager)).toEqual({ args, env: { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } });
  });
});
