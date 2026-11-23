import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/*
 * Each test file gets its own temporary directory. `init` sweeps every
 * `e2e-agent-desktop-*` directory under `os.tmpdir()`, and kills the
 * processes their launch records name: in a shared one, a run of the suite
 * in another checkout, or another test file in this run, would sweep the
 * directories a test plants and expects to find, and a developer's own
 * leftovers from a real desktop run would be swept by `pnpm test`.
 * `os.tmpdir()` reads `TMPDIR` on every call.
 */
const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-tests-'));
process.env.TMPDIR = directory;

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
