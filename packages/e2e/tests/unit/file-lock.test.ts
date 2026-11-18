import { type ChildProcess, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { withFileLock } from '../../src/internal/file-lock.ts';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, statSync: vi.fn(fs.statSync), writeFileSync: vi.fn(fs.writeFileSync), rmSync: vi.fn(fs.rmSync), utimesSync: vi.fn(fs.utimesSync) };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

const dirs: string[] = [];
/** A lock path in a fresh directory. */
function tempLock(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-lock-'));
  dirs.push(dir);
  return path.join(dir, 'x.lock');
}
afterEach(() => {
  for (const mocked of [statSync, writeFileSync, rmSync, utimesSync]) vi.mocked(mocked).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const nsPath = '/proc/self/ns/pid';
/** This host and pid namespace, as a lock names them. */
const host = existsSync(nsPath) ? `${hostname()}/${readlinkSync(nsPath)}` : hostname();
/** What a lock held by `pid` on this host holds. */
const heldBy = (pid: number) => `${host} ${pid} other`;
/** The pid of a process that has exited. */
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Sets the file's times `seconds` from now. */
const age = (file: string, seconds: number) => utimesSync(file, Date.now() / 1000 + seconds, Date.now() / 1000 + seconds);
const busy = () => new Error('busy');
/** Holds the lock at `lockPath` for `work`, giving up after 5 s. */
const hold = <T>(lockPath: string, work: () => Promise<T>) => withFileLock(lockPath, 5_000, busy, work);
/** Whether `hold` enters within 150 ms; the attempt is left to finish once the lock is removed. */
async function entersAtOnce(lockPath: string): Promise<{ entered: boolean; pending: Promise<unknown> }> {
  const state = { entered: false };
  const pending = hold(lockPath, async () => {
    state.entered = true;
  });
  await sleep(150);
  return { entered: state.entered, pending };
}

describe('withFileLock', () => {
  it('holds the lock while the work runs and removes it after', async () => {
    const lock = tempLock();
    expect(await hold(lock, async () => existsSync(lock))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('releases the lock when the work throws', async () => {
    const lock = tempLock();
    await expect(hold(lock, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(lock)).toBe(false);
    expect(await hold(lock, async () => 'next')).toBe('next');
  });

  it.runIf(existsSync(nsPath))('names its host, pid namespace, and pid in the lock', async () => {
    const lock = tempLock();
    const [holderHost, pid] = await hold(lock, async () => readFileSync(lock, 'utf8').split(' '));
    expect([holderHost, pid]).toEqual([`${hostname()}/${readlinkSync(nsPath)}`, String(process.pid)]);
  });

  it.each([
    ['this process', () => heldBy(process.pid)],
    // Run as root, pid 1 can be signalled, so this checks a running process instead.
    ['a process of another user', () => heldBy(1)],
    ['another host', () => `elsewhere.example ${exitedPid()} other`],
    ['no pid', () => `${host} unknown other`],
  ])('waits for a fresh lock held by %s', async (_holder, content) => {
    const lock = tempLock();
    writeFileSync(lock, content());
    const { entered, pending } = await entersAtOnce(lock);
    expect(entered).toBe(false);
    rmSync(lock);
    await pending;
  });

  it('takes over at once a lock whose holder exited', async () => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(exitedPid()));
    const started = Date.now();
    expect(await hold(lock, async () => 'entered')).toBe('entered');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(existsSync(lock)).toBe(false);
  });

  it('takes over an empty lock gone untouched, as an older e2e leaves it', async () => {
    const lock = tempLock();
    writeFileSync(lock, '');
    age(lock, -60);
    expect(await hold(lock, async () => 'entered')).toBe('entered');
  });

  it('takes over a lock its holder stopped touching, even when the pid runs', async () => {
    const lock = tempLock();
    // A pid that now belongs to another program, or a holder suspended past the stale bound.
    writeFileSync(lock, heldBy(process.pid));
    age(lock, -60);
    const { entered, pending } = await entersAtOnce(lock);
    expect(entered).toBe(true);
    await pending;
  });

  it('never takes over a lock another process created after the check', async () => {
    const lock = tempLock();
    writeFileSync(lock, '');
    age(lock, -60);
    // Between this process's stale check and its takeover, another process takes the stale lock over and holds a fresh one.
    vi.mocked(statSync).mockImplementationOnce(((target: string) => {
      const stats = realFs.statSync(target);
      realFs.rmSync(lock);
      realFs.writeFileSync(lock, heldBy(process.pid));
      return stats;
    }) as typeof statSync);
    const { entered, pending } = await entersAtOnce(lock);
    expect(entered).toBe(false);
    rmSync(lock);
    await pending;
  });

  it.each([
    ['its first check, before its takeover turn', 1],
    ['the check in its takeover turn', 2],
  ])('lets one waiter through a crashed holder\'s lock when another takes it over during %s', async (_when, check) => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(exitedPid()));
    let inside = 0;
    let most = 0;
    const work = async () => {
      most = Math.max(most, ++inside);
      await sleep(50);
      inside--;
    };
    // Each check asks whether the holder's pid still runs. On the chosen one, a second waiter runs its own takeover in the gap,
    // synchronously, as another process could between this waiter's check and its removal of the lock.
    const kill = process.kill.bind(process);
    let checks = 0;
    let other: Promise<void> | undefined;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (++checks === check) other = hold(lock, work);
      return kill(pid, signal);
    });
    try {
      await hold(lock, work);
      await other;
    } finally {
      vi.mocked(process.kill).mockRestore();
    }
    expect(other).toBeDefined();
    expect(most).toBe(1);
  });

  // Real processes, as a soak check. Their races land at random, so a missing takeover turn shows up on most runs but
  // not all; the two-waiter cases above are the tests that fail every time.
  it('lets one process at a time through locks that holders keep crashing with', async () => {
    const lock = tempLock();
    const dir = path.dirname(lock);
    const log = path.join(dir, 'log');
    const stop = path.join(dir, 'stop');
    writeFileSync(log, '');
    const worker = [
      '--import',
      new URL('../../src/config/register.ts', import.meta.url).href,
      fileURLToPath(new URL('./helpers/file-lock-worker.ts', import.meta.url)),
    ];
    // Every process boots before the start, then half the holds end as a crash that leaves the lock behind.
    const args = [lock, log, String(exitedPid()), String(Date.now() + 2_000), stop];
    const workers: { failed?: unknown } = {};
    // Killed when the test ends, even on a timeout, so a worker that hangs is not left running.
    const children: ChildProcess[] = [];
    onTestFinished(() => {
      for (const child of children) child.kill('SIGKILL');
    });
    const spawn = () => {
      const run = promisify(execFile)(process.execPath, [...worker, ...args]);
      children.push(run.child);
      return run;
    };
    const exited = Promise.all(Array.from({ length: 12 }, spawn)).catch((cause: unknown) => {
      workers.failed = cause;
    });
    const crashes = () => readFileSync(log, 'utf8').split('\n').filter((line) => line.startsWith('x')).length;
    try {
      // Each crash is one more race between waiters to take the lock over.
      while (crashes() < 300 && workers.failed === undefined) await sleep(100);
    } finally {
      writeFileSync(stop, '');
    }
    await exited;
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    let holder: string | undefined;
    const overlaps: string[] = [];
    for (const [index, line] of lines.entries()) {
      const [mark, pid] = [line[0], line.slice(1)];
      if (mark === '+' && holder !== undefined) overlaps.push(`line ${index + 1}: ${pid} entered while ${holder} held the lock`);
      if (mark === '!') overlaps.push(`line ${index + 1}: ${pid} lost the lock while holding it`);
      holder = mark === '+' ? pid : mark === '-' || mark === 'x' ? undefined : holder;
    }
    expect(overlaps).toEqual([]);
    expect(workers.failed).toBeUndefined();
  }, 60_000);

  it('takes over the turn of a waiter that exited during it', async () => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(exitedPid()));
    writeFileSync(`${lock}.break`, heldBy(exitedPid()));
    const { entered, pending } = await entersAtOnce(lock);
    expect(entered).toBe(true);
    await pending;
    expect(readdirSync(path.dirname(lock))).toEqual([]);
  });

  it('leaves the turn of a live waiter whose file it could not stat', async () => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(exitedPid()));
    const breaker = `${lock}.break`;
    writeFileSync(breaker, heldBy(process.pid));
    // The turn's holder runs, so the check reads its age, and that read fails as if the file had just been removed.
    vi.mocked(statSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    });
    const { entered, pending } = await entersAtOnce(lock);
    expect(entered).toBe(false);
    expect(existsSync(breaker)).toBe(true);
    rmSync(breaker);
    await pending;
  });

  it('keeps a held lock fresh, so waiters never take it as untouched', async () => {
    const lock = tempLock();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await hold(lock, async () => {
        age(lock, -60);
        // A holder touches its lock several times within the stale bound.
        vi.advanceTimersByTime(3_000);
        expect(statSync(lock).mtimeMs).toBeGreaterThan(Date.now() - 5_000);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its heartbeat going when the lock vanishes between the check and the touch', async () => {
    const lock = tempLock();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await hold(lock, async () => {
        vi.mocked(utimesSync).mockImplementationOnce(() => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        });
        expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never removes or touches a lock it no longer holds', async () => {
    const lock = tempLock();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await hold(lock, async () => {
        // A waiter took the lock over and holds it now.
        writeFileSync(lock, heldBy(process.pid));
        age(lock, -60);
        vi.advanceTimersByTime(10_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(readFileSync(lock, 'utf8')).toBe(heldBy(process.pid));
    expect(statSync(lock).mtimeMs).toBeLessThan(Date.now() - 30_000);
  });

  it('leaves the lock of another attempt in this process that took over', async () => {
    const lock = tempLock();
    let second: Promise<unknown> = Promise.resolve();
    let finishSecond = () => {};
    await hold(lock, async () => {
      // Untouched past the stale bound, so a second attempt from this process takes it over.
      age(lock, -60);
      let entered = () => {};
      const inside = new Promise<void>((resolve) => (entered = resolve));
      second = hold(lock, () => {
        entered();
        return new Promise<void>((resolve) => (finishSecond = resolve));
      });
      await inside;
    });
    expect(existsSync(lock)).toBe(true);
    finishSecond();
    await second;
    expect(existsSync(lock)).toBe(false);
  });

  it('gives up with the busy error once another holder keeps the lock past the wait', async () => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(process.pid));
    // Touched in the future, so the lock stays fresh however far the fake clock moves.
    age(lock, 3_600);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const pending = withFileLock(lock, 30_000, busy, async () => {}).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toThrow('busy');
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on time while another waiter holds the takeover turn', async () => {
    const lock = tempLock();
    writeFileSync(lock, heldBy(exitedPid()));
    age(lock, -60);
    writeFileSync(`${lock}.break`, heldBy(process.pid));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const pending = expect(hold(lock, async () => {})).rejects.toThrow('busy');
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on time while the locks of exiting holders keep replacing each other', async () => {
    const lock = tempLock();
    const exited = heldBy(exitedPid());
    writeFileSync(lock, exited);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Each takeover is followed by another holder taking the lock and exiting, a second later.
    let takeovers = 0;
    vi.mocked(rmSync).mockImplementation(((target: string, options?: object) => {
      realFs.rmSync(target, options);
      if (target === lock && takeovers++ < 20) {
        realFs.writeFileSync(lock, exited);
        vi.setSystemTime(Date.now() + 1_000);
      }
    }) as typeof rmSync);
    try {
      await expect(hold(lock, async () => {})).rejects.toThrow('busy');
      expect(takeovers).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no lock behind when writing its holder fails', async () => {
    const lock = tempLock();
    vi.mocked(writeFileSync).mockImplementationOnce(((fd: number, data: string) => {
      realFs.writeFileSync(fd, data.slice(0, 10));
      throw Object.assign(new Error('file too large'), { code: 'EFBIG' });
    }) as unknown as typeof writeFileSync);
    await expect(hold(lock, async () => 'entered')).rejects.toThrow('file too large');
    expect(readdirSync(path.dirname(lock))).toEqual([]);
    expect(await hold(lock, async () => 'entered')).toBe('entered');
  });

  it('fails at once when the lock cannot be created', async () => {
    const lock = path.join(path.dirname(tempLock()), 'missing', 'x.lock');
    const started = Date.now();
    await expect(hold(lock, async () => 'entered')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
