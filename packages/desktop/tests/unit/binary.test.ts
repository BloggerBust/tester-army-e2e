import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPinned, pinnedExecutable, resolveExecutable } from '../../src/binary.ts';

/** Runs before every rename the install makes, so a test can hold one at a chosen point while another run goes ahead. */
const hooks = vi.hoisted(() => ({ beforeRename: (_from: string, _to: string): Promise<void> => Promise.resolve() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      await hooks.beforeRename(from, to);
      return actual.rename(from, to);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  hooks.beforeRename = () => Promise.resolve();
});

/** A release archive of its own, with its digest as the pinned one for every target. */
function release(home: string): { bytes: Buffer; digest: string; digests: Record<string, string> } {
  const files = path.join(home, 'release');
  mkdirSync(files);
  for (const name of ['agent-desktop', 'agent-desktop-macos-helper']) writeFileSync(path.join(files, name), '#!/bin/sh\necho 1.3.1\n', { mode: 0o755 });
  const archive = path.join(home, 'release.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', files, '.']);
  const bytes = readFileSync(archive);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { bytes, digest, digests: Object.fromEntries(['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'].map((target) => [target, digest])) };
}

describe('the pinned agent-desktop', () => {
  it('lives in the OS cache, never in the replay cache E2E_CACHE_DIR names', () => {
    const env = { HOME: '/home/ada', USERPROFILE: '/home/ada', XDG_CACHE_HOME: '/home/ada/.cache', LOCALAPPDATA: '/home/ada/local' };
    expect(pinnedExecutable({ ...env, E2E_CACHE_DIR: '.e2e/cache' })).toBe(pinnedExecutable(env));
    expect(pinnedExecutable(env)).toMatch(/^\/home\/ada\/.*[\\/]e2e[\\/]/);
  });

  it('refuses an archive whose SHA-256 is not the pinned one, and caches nothing', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    const env = { HOME: '/nonexistent', USERPROFILE: '/nonexistent', XDG_CACHE_HOME: '/nonexistent/cache', LOCALAPPDATA: '/nonexistent/local' };
    await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED', message: expect.stringMatching(/refusing to unpack/) });
    expect(existsSync(pinnedExecutable(env)!)).toBe(false);
  });

  it('downloads again over a cache entry that is whole but no verified unpack stamped, or one stamped for another release', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const executable = pinnedExecutable(env)!;
      const entry = path.dirname(executable);
      mkdirSync(entry, { recursive: true });
      // Everything a checked unpack leaves but the stamp, so the stamp alone decides.
      for (const name of [executable, path.join(entry, 'agent-desktop-macos-helper')]) {
        writeFileSync(name, '#!/bin/sh\n');
        chmodSync(name, 0o755);
      }
      let fetched = 0;
      vi.stubGlobal('fetch', () => {
        fetched += 1;
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
      });
      await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
      expect(fetched).toBe(1);
      writeFileSync(path.join(entry, '.verified'), 'the digest of another release');
      await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
      expect(fetched).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('unpacks a checked archive into the cache once, however many runs install it at the same time', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      let fetched = 0;
      vi.stubGlobal('fetch', () => {
        fetched += 1;
        return Promise.resolve(new Response(new Uint8Array(bytes)));
      });
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      const [first, second] = await Promise.all([install(), install()]);
      expect(first).toBe(pinnedExecutable(env));
      expect(second).toBe(first);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readFileSync(path.join(path.dirname(first), '.verified'), 'utf8')).toBe(digest);
      // Nothing but the entry is left beside it: no staging directory, no stale copy.
      expect(readdirSync(path.dirname(path.dirname(first)))).toEqual([path.basename(path.dirname(first))]);
      // A whole, checked entry is used as it is.
      const before = fetched;
      await install();
      expect(fetched).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('replaces a damaged cache entry with a checked unpack', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      // Stamped, but its executable lost: what a cleaner that deleted one file leaves.
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const executable = await installPinned(env, new AbortController().signal, () => undefined, digests);
      expect(execFileSync(executable, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('repairs a damaged entry when three runs repair it at the same time, and leaves nothing beside it', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      const [first] = await Promise.all([install(), install(), install()]);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the copy another run put in place while this one was replacing a damaged entry', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      // The first run has moved the damaged entry aside; before it puts its own copy in, a second run installs whole.
      let second: Promise<string> | undefined;
      hooks.beforeRename = async (from, to) => {
        if (second !== undefined || to !== entry || existsSync(entry) || !from.includes('.partial-')) return;
        second = install();
        await second;
      };
      const first = await install();
      expect(second).toBeDefined();
      expect(await second).toBe(first);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('puts back a whole copy it moved aside, which another run put in place after it found the entry damaged', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digest, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const install = () => installPinned(env, new AbortController().signal, () => undefined, digests);
      // The first run found the entry damaged; before it moves it aside, a second run replaces it whole.
      let second: Promise<string> | undefined;
      const moved: string[] = [];
      hooks.beforeRename = async (from, to) => {
        if (from === entry) moved.push(to);
        if (second !== undefined || from !== entry) return;
        second = install();
        await second;
      };
      const first = await install();
      expect(await second).toBe(first);
      // Both runs moved an entry aside: the damaged one, then the second run's whole copy, which went back.
      expect(moved).toHaveLength(2);
      expect(execFileSync(first, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('names why the unpack could not be put in place, when it is not another run', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      hooks.beforeRename = (_from, to) => (to === entry ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, rename -> '${to}'`), { code: 'EACCES' })) : Promise.resolve());
      await expect(installPinned(env, new AbortController().signal, () => undefined, digests)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED', message: expect.stringMatching(/EACCES: permission denied/), cause: expect.objectContaining({ code: 'EACCES' }) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes the unpacks and moved-aside entries a killed install left a day ago, and keeps newer ones', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const { bytes, digests } = release(home);
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      mkdirSync(path.dirname(entry), { recursive: true });
      const leftovers = ['.partial-old', '.stale-1-old', '.partial-new'].map((suffix) => `${entry}${suffix}`);
      for (const leftover of leftovers) mkdirSync(leftover);
      const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      for (const leftover of leftovers.slice(0, 2)) utimesSync(leftover, dayAgo, dayAgo);
      await installPinned(env, new AbortController().signal, () => undefined, digests);
      expect(leftovers.map((leftover) => existsSync(leftover))).toEqual([false, false, true]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a directory as the binary, though the execute check passes on a searchable one', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      await expect(resolveExecutable(home, process.cwd(), {})).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringMatching(/not an executable file/) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reports a failed download as AGENT_DESKTOP_INSTALL_FAILED', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const env = { HOME: '/nonexistent', USERPROFILE: '/nonexistent', XDG_CACHE_HOME: '/nonexistent/cache', LOCALAPPDATA: '/nonexistent/local' };
    await expect(installPinned(env, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'AGENT_DESKTOP_INSTALL_FAILED' });
  });
});
