/**
 * An engine server process for the protocol tests: a toy engine served over
 * stdio, which reports what it received on stderr so a test can read it off
 * a failure message. `initializationOptions.crashOnObserve` makes `observe`
 * write to stderr and exit the process mid-request; `crashMode` changes how:
 *
 * - `stdout-first`: it closes its stdout 300 ms before it writes and exits.
 * - `late-child`: it exits, and a child that shares its stderr writes there
 *   300 ms later.
 * - `stays-up`: it closes its stdout, writes, and never exits.
 * - `signal`: it writes and stops itself with SIGKILL.
 *
 * `hangDoctor` adds a `doctor` that logs the pid and never returns, in a
 * process that ignores SIGTERM.
 */

import { spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { defineEngine, serveEngine } from '../../src/engine/index.ts';

export type CrashMode = 'stdout-first' | 'late-child' | 'stays-up' | 'signal';

interface ServerOptions {
  readonly crashOnObserve?: boolean;
  readonly crashMode?: CrashMode;
  readonly hangDoctor?: boolean;
}

/** Fails the request the way `mode` says: the process exits, or, for `stays-up`, closes its stdout. */
async function crash(mode: CrashMode | undefined): Promise<never> {
  if (mode === 'stdout-first' || mode === 'stays-up') {
    closeSync(1);
    await delay(300);
  }
  if (mode === 'stays-up') {
    process.stderr.write('toy server: stdout closed, staying\n');
    return new Promise(() => {});
  }
  if (mode === 'late-child') {
    const late = "setTimeout(() => process.stderr.write('toy server child: late line\\n'), 300)";
    spawn(process.execPath, ['-e', late], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (mode === 'signal') {
    process.stderr.write('toy server: crashing on purpose\n', () => process.kill(process.pid, 'SIGKILL'));
    return new Promise(() => {});
  }
  process.stderr.write('toy server: crashing on purpose\n');
  process.exit(7);
}

await serveEngine((options) => {
  const { crashOnObserve = false, crashMode, hangDoctor = false } = (options ?? {}) as ServerOptions;
  return defineEngine({
    name: 'toy-server',
    version: '1.0.0',
    spiVersion: 1,
    platform: 'toy',
    actions: ['tap'],
    async observe() {
      if (crashOnObserve) await crash(crashMode);
      return {
        root: { ref: { id: 'root', revision: '' }, role: 'root', children: [{ ref: { id: 'n1', revision: '' }, role: 'button', name: 'Save' }] },
        viewport: { width: 100, height: 100 },
        location: `pid:${String(process.pid)}`,
      };
    },
    async perform() {},
    async init(info) {
      info.log(`init slot ${String(info.workerSlot)}`);
    },
    ...(hangDoctor
      ? {
          async doctor(info) {
            process.on('SIGTERM', () => {});
            setInterval(() => {}, 1000);
            info.log(`pid:${String(process.pid)}`);
            return new Promise(() => {});
          },
        }
      : {}),
  });
});
