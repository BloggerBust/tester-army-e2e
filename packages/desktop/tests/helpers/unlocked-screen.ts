import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/*
 * A stand-in `ioreg`, first on PATH, that reports the screen unlocked: the
 * engine asks macOS whether the screen is locked when a launch shows no
 * readable window, and the answer on the machine running the tests must not
 * change what a test reads. A test of a locked screen puts its own first.
 */
const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-ioreg-'));
writeFileSync(path.join(directory, 'ioreg'), "#!/bin/sh\nprintf '<key>CGSSessionScreenIsLocked</key>\\n<false/>\\n'\n", { mode: 0o755 });
process.env.PATH = `${directory}${path.delimiter}${process.env.PATH ?? ''}`;

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
