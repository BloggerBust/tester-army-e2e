/**
 * A lock file shared across processes, for work that runs one process at a
 * time. The file names its holder (`lockToken`), and the holder touches it
 * while it holds it, so waiters take it over at once when a holder on this
 * host and pid namespace has exited, and otherwise only once it has gone
 * untouched for the stale bound.
 * The holder touches and removes only a lock that names it.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { sleep } from '@e2e-dev/core/lib/internal/time';

const LOCK_RETRY_MS = 25;
/** How long a lock may go untouched before waiters take it over, whoever it names. */
const LOCK_STALE_MS = 10_000;

/** Runs `work` holding the lock at `lockPath`; throws `busy()` once another holder has kept it `waitMs`. */
export async function withFileLock<T>(
  lockPath: string,
  waitMs: number,
  busy: () => Error,
  work: () => Promise<T>,
): Promise<T> {
  const release = await acquire(lockPath, waitMs, busy);
  try {
    return await work();
  } finally {
    release();
  }
}

/**
 * Waits for the lock and returns its release. A holder paused past the stale
 * bound between the release's read and its remove can remove the lock of the
 * waiter that took over: the same accepted cost as losing its own lock.
 */
async function acquire(lockPath: string, waitMs: number, busy: () => Error): Promise<() => void> {
  const token = lockToken();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (claim(lockPath, token)) {
      const heartbeat = setInterval(() => {
        if (readLock(lockPath) === token) touch(lockPath);
      }, LOCK_STALE_MS / 4);
      return () => {
        clearInterval(heartbeat);
        if (readLock(lockPath) === token) rmSync(lockPath, { force: true });
      };
    }
    if (Date.now() > deadline) throw busy();
    if (abandoned(lockPath) && breakAbandoned(lockPath)) continue;
    await sleep(LOCK_RETRY_MS);
  }
}

/** Creates `lockPath` holding `token`, false when it exists; a lock whose write failed is removed. */
function claim(lockPath: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw cause;
  }
  try {
    // Writes the whole token: a cut-off one could name a pid that has exited.
    writeFileSync(fd, token);
  } catch (cause) {
    rmSync(lockPath, { force: true });
    throw cause;
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * This host and, where the system has them, its pid namespace, since a
 * sandbox on the same host sees none of the pids outside it.
 */
function holderHost(): string {
  try {
    return `${hostname()}/${readlinkSync('/proc/self/ns/pid')}`;
  } catch {
    return hostname();
  }
}

/** This process on this host, and a random part no other holder shares. */
function lockToken(): string {
  return `${holderHost()} ${process.pid} ${randomUUID()}`;
}

/** Marks the lock as held now. */
function touch(lockPath: string): void {
  const now = new Date();
  try {
    utimesSync(lockPath, now, now);
  } catch {
    // Released meanwhile.
  }
}

/** The lock's holder token, undefined when there is no lock. */
function readLock(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * True when the lock's holder on this host and pid namespace has exited, or
 * the lock has gone untouched for the stale bound. The bound covers what the
 * pid cannot tell: a lock from another host, sandbox, or older e2e, a pid
 * another program now has, and a holder suspended that long, which then
 * loses its lock.
 */
function abandoned(lockPath: string): boolean {
  const [host, pid] = (readLock(lockPath) ?? '').split(' ');
  if (host === holderHost() && pid !== undefined && /^\d+$/.test(pid) && !running(Number(pid))) return true;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** True while `pid` exists, whoever owns it. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: the process exists but belongs to another user.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Removes an abandoned lock, false when another waiter is removing it.
 * Waiters take turns through a second lock file and check the holder again
 * while they hold it, so a lock created after the first check is never
 * removed. A waiter that exits inside its turn, which lasts microseconds,
 * leaves that file for the next waiter to take over; two waiters doing so at
 * the same moment can still both remove.
 */
function breakAbandoned(lockPath: string): boolean {
  const breaker = `${lockPath}.break`;
  if (!claim(breaker, lockToken())) {
    if (abandoned(breaker)) rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (abandoned(lockPath)) rmSync(lockPath, { force: true });
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}
