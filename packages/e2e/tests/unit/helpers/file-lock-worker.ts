/**
 * One process for the crash-loop lock test. From the time in argv[5] until
 * the file at argv[6] exists it takes the lock at argv[2] over and over. Each time
 * it writes `+pid` to the log at argv[3] on entering, then either leaves
 * with `-pid` or, as if it crashed while holding the lock, writes `xpid` and
 * leaves the lock naming the exited pid in argv[4]. It writes `!pid` when
 * its lock was removed or replaced while it held it.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { withFileLock } from '../../../src/internal/file-lock.ts';

const [lockPath, log, exitedPid, startAt, stop] = process.argv.slice(2) as [string, string, string, string, string];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The lock's content, undefined once it is gone. */
function readLock(): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

await sleep(Number(startAt) - Date.now());
while (!existsSync(stop)) {
  await withFileLock(lockPath, 20_000, () => new Error('lock wait timed out'), async () => {
    appendFileSync(log, `+${process.pid}\n`);
    const token = readLock() ?? '';
    await sleep(1);
    if (readLock() !== token) appendFileSync(log, `!${process.pid}\n`);
    if (Math.random() < 0.5) {
      appendFileSync(log, `-${process.pid}\n`);
      return;
    }
    // What a crash leaves: this host's lock, naming a pid that no longer runs.
    const [host] = token.split(' ');
    appendFileSync(log, `x${process.pid}\n`);
    writeFileSync(lockPath, `${host} ${exitedPid} crashed`);
  });
}
