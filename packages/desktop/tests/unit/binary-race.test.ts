import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPinned, pinnedExecutable } from '../../src/binary.ts';

/** What the mocked `rename` does after it moves an entry aside: another run publishing at the same time fills the gap. */
const race = vi.hoisted(() => ({ onAside: undefined as undefined | ((entry: string) => void) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: async (from: string, to: string) => {
      await original.rename(from, to);
      if (to.includes('.stale-')) race.onAside?.(from);
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  race.onAside = undefined;
});

describe('the pinned agent-desktop, published while a repair runs', () => {
  it.skipIf(process.platform === 'win32')('accepts the verified copy another run published into the gap a repair made', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-cache-'));
    try {
      const files = path.join(home, 'release');
      mkdirSync(files);
      for (const name of ['agent-desktop', 'agent-desktop-macos-helper']) writeFileSync(path.join(files, name), '#!/bin/sh\necho 1.3.1\n', { mode: 0o755 });
      const archive = path.join(home, 'release.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', files, '.']);
      const bytes = readFileSync(archive);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const digests = Object.fromEntries(['aarch64-apple-darwin', 'x86_64-apple-darwin', 'aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu'].map((target) => [target, digest]));
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(new Uint8Array(bytes))));
      const env = { HOME: home, USERPROFILE: home, XDG_CACHE_HOME: path.join(home, 'cache'), LOCALAPPDATA: path.join(home, 'local') };
      const entry = path.dirname(pinnedExecutable(env)!);
      // Stamped, but its executable lost: damaged, so the install moves it aside and publishes its own.
      mkdirSync(entry, { recursive: true });
      writeFileSync(path.join(entry, '.verified'), digest);
      const winner = path.join(home, 'winner');
      cpSync(files, winner, { recursive: true });
      writeFileSync(path.join(winner, '.verified'), digest);
      race.onAside = (original) => cpSync(winner, original, { recursive: true });
      const executable = await installPinned(env, new AbortController().signal, () => undefined, digests);
      expect(existsSync(executable)).toBe(true);
      expect(execFileSync(executable, { encoding: 'utf8' }).trim()).toBe('1.3.1');
      expect(readdirSync(path.dirname(entry))).toEqual([path.basename(entry)]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
