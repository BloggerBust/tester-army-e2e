import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The scripted agent-desktop. */
const FAKE_SCRIPT = path.resolve(import.meta.dirname, 'fake-agent-desktop.mjs');

/** One call the fake received. */
export interface FakeCall {
  readonly key: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly home?: string;
  /** The command's `TMPDIR`. */
  readonly tmpdir?: string;
  /** The names of the variables in the fake's environment. */
  readonly envNames: readonly string[];
}

/** Answers by command (`snapshot`, `select`): each call takes the next, the last repeats. */
export type Scenario = Record<string, readonly unknown[]>;

/** The directories scenarios were written to, removed by `cleanupFakes`. */
const directories: string[] = [];

/** Removes every scenario directory written so far; call it after each test, once its fake processes have stopped. */
export function cleanupFakes(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

/**
 * A scenario on disk, an executable that runs the fake on it, and the run's
 * environment. The paths are written into the executable, since the engine
 * hands agent-desktop only a few variables of the run's environment.
 */
export function fakeScenario(scenario: Scenario): { binary: string; env: Record<string, string>; calls: () => FakeCall[]; spawned: () => number[] } {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-fake-agent-desktop-'));
  directories.push(directory);
  const file = path.join(directory, 'scenario.json');
  const log = path.join(directory, 'calls.jsonl');
  writeFileSync(file, JSON.stringify(scenario));
  const binary = path.join(directory, 'agent-desktop');
  writeFileSync(binary, `#!/bin/sh\nFAKE_AD_SCENARIO=${JSON.stringify(file)} FAKE_AD_LOG=${JSON.stringify(log)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SCRIPT)} "$@"\n`);
  chmodSync(binary, 0o755);
  return {
    binary,
    env: { ...(process.env as Record<string, string>) },
    spawned: () => {
      try {
        return readFileSync(`${log}.spawned`, 'utf8').split('\n').filter(Boolean).map(Number);
      } catch {
        return [];
      }
    },
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeCall);
      } catch {
        return [];
      }
    },
  };
}

/** A snapshot fixture's `data`, as a scenario answer. */
export function snapshotAnswer(name: string): unknown {
  return { ok: true, data: JSON.parse(readFileSync(new URL(`../fixtures/snapshots/${name}.json`, import.meta.url), 'utf8')) };
}

/** A failed envelope. */
export function failure(code: string, delivery: 'not_delivered' | 'delivered_unverified' | 'unknown', message = `${code} from the fake`): unknown {
  return { ok: false, error: { code, message, disposition: { delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' } } };
}
