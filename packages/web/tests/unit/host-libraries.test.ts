import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missingHostLibraries, missingLibrariesMessage } from '../../src/host-libraries.ts';

const LISTING = [
  '\tlinux-vdso.so.1 (0x0000ffff9d0f2000)',
  '\tlibdl.so.2 => /lib/aarch64-linux-gnu/libdl.so.2 (0x0000ffff8f6a0000)',
  '\tlibglib-2.0.so.0 => not found',
  '\tlibnss3.so => not found',
  '\t/lib/ld-linux-aarch64.so.1 (0x0000ffff9d0b5000)',
  '',
].join('\n');

describe('missingHostLibraries', () => {
  let directory: string;
  let executable: string;

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'e2e-host-libraries-'));
    executable = path.join(directory, 'chrome-headless-shell');
    for (const name of ['chrome-headless-shell', 'libEGL.so', 'libvulkan.so.1', 'icudtl.dat']) writeFileSync(path.join(directory, name), '');
    mkdirSync(path.join(directory, 'locales.so'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('asks ldd about the executable and the libraries beside it, once per missing name', async () => {
    const asked: Array<{ file: string; searchPath: string | undefined }> = [];
    const missing = await missingHostLibraries(executable, { LD_LIBRARY_PATH: '/opt/lib' }, {
      platform: 'linux',
      ldd: async (file, env) => {
        asked.push({ file: path.basename(file), searchPath: env['LD_LIBRARY_PATH'] });
        return path.basename(file) === 'libEGL.so' ? '\tlibnss3.so => not found\n\tlibX11.so.6 => not found\n' : LISTING;
      },
    });
    expect(asked.map((ask) => ask.file).toSorted()).toEqual(['chrome-headless-shell', 'libEGL.so', 'libvulkan.so.1']);
    expect(new Set(asked.map((ask) => ask.searchPath))).toEqual(new Set(['/opt/lib:$ORIGIN']));
    expect(missing.toSorted()).toEqual(['libX11.so.6', 'libglib-2.0.so.0', 'libnss3.so']);
  });

  it('names only the libraries a listing marks not found', async () => {
    const listed = (listing: string) => missingHostLibraries(executable, {}, { platform: 'linux', ldd: async (file) => (file === executable ? listing : '') });
    expect(await listed(LISTING)).toEqual(['libglib-2.0.so.0', 'libnss3.so']);
    expect(await listed('\tnot a dynamic executable\n')).toEqual([]);
  });

  it('searches the directory of the file alone when the environment names no path', async () => {
    for (const env of [{}, { LD_LIBRARY_PATH: '' }]) {
      const searchPaths = new Set<string | undefined>();
      await missingHostLibraries(executable, env, {
        platform: 'linux',
        ldd: async (_file, lddEnv) => {
          searchPaths.add(lddEnv['LD_LIBRARY_PATH']);
          return '';
        },
      });
      expect(searchPaths).toEqual(new Set(['$ORIGIN']));
    }
  });

  describe('with an ldd on the PATH', () => {
    let bin: string;

    /** Puts `script` on the PATH as `ldd`; resolves to the environment that finds it. */
    const withLdd = (script: string): NodeJS.ProcessEnv => {
      writeFileSync(path.join(bin, 'ldd'), `#!/bin/sh\n${script}\n`);
      chmodSync(path.join(bin, 'ldd'), 0o755);
      return { PATH: bin };
    };

    beforeEach(() => {
      bin = mkdtempSync(path.join(tmpdir(), 'e2e-host-libraries-bin-'));
    });

    afterEach(() => {
      rmSync(bin, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32')('reads what ldd prints for each file, with the search path it was given', async () => {
      const env = withLdd('printf "\\tlib%s.so => not found\\n" "${1##*/}"\nprintf "\\t%s => not found\\n" "$LD_LIBRARY_PATH"');
      const missing = await missingHostLibraries(executable, { ...env, LD_LIBRARY_PATH: '/opt/lib' }, { platform: 'linux' });
      expect(missing.toSorted()).toEqual(['/opt/lib:$ORIGIN', 'libchrome-headless-shell.so', 'liblibEGL.so.so', 'liblibvulkan.so.1.so']);
    });

    it.skipIf(process.platform === 'win32')('reports nothing from an ldd that fails', async () => {
      const env = withLdd('printf "\\tlibnss3.so => not found\\n"\nexit 1');
      expect(await missingHostLibraries(executable, env, { platform: 'linux' })).toEqual([]);
    });

    it.skipIf(process.platform === 'win32')('kills an ldd that outlives its time or the signal, with the loader it started, and reports nothing', async () => {
      const loader = path.join(bin, 'loader.pid');
      // As the real ldd does, the script waits on a child of its own.
      const env = withLdd(`printf "\\tlibnss3.so => not found\\n"\n/bin/sleep 30 &\necho $! > ${loader}\nwait`);
      const alive = (): boolean => {
        try {
          process.kill(Number(readFileSync(loader, 'utf8')), 0);
          return true;
        } catch {
          return false;
        }
      };
      const stopped = async (probe: { timeoutMs?: number; signal?: AbortSignal }): Promise<void> => {
        rmSync(loader, { force: true });
        expect(await missingHostLibraries(executable, env, { platform: 'linux', ...probe })).toEqual([]);
        if (probe.signal?.aborted !== true) expect(existsSync(loader)).toBe(true);
        await expect.poll(alive).toBe(false);
      };
      const started = Date.now();
      await stopped({ timeoutMs: 300 });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      await stopped({ signal: controller.signal });
      await stopped({ signal: controller.signal });
      expect(Date.now() - started).toBeLessThan(4_000);
    });
  });

  it('reports nothing when ldd is absent or cannot read the file', async () => {
    expect(await missingHostLibraries(executable, {}, { platform: 'linux', ldd: async () => undefined })).toEqual([]);
  });

  it.runIf(process.platform === 'linux')('resolves every library of a binary that runs here with the host ldd', async () => {
    expect(await missingHostLibraries(process.execPath, process.env)).toEqual([]);
  });

  it('never runs ldd off Linux', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const missing = await missingHostLibraries(executable, {}, {
        platform,
        ldd: async () => {
          throw new Error('ldd ran');
        },
      });
      expect(missing).toEqual([]);
    }
  });
});

describe('missingLibrariesMessage', () => {
  it('lists the first five libraries and counts the rest', () => {
    const libraries = ['a.so', 'b.so', 'c.so', 'd.so', 'e.so', 'f.so', 'g.so'];
    expect(missingLibrariesMessage('firefox', libraries)).toBe(
      'firefox cannot launch: 7 system libraries are missing (a.so, b.so, c.so, d.so, e.so and 2 more); run "npx @e2e-dev/web install firefox --with-deps" (pnpm: "pnpm exec e2e-web install firefox --with-deps")',
    );
    expect(missingLibrariesMessage('chromium', ['libnss3.so'])).toBe(
      'chromium cannot launch: a system library is missing (libnss3.so); run "npx @e2e-dev/web install chromium --with-deps" (pnpm: "pnpm exec e2e-web install chromium --with-deps")',
    );
  });
});
