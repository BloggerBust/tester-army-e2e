/**
 * The run-level lifecycle an engine joins in the runner process: what
 * `prepare` is handed and may return, once per run and target before any
 * worker exists, and what `finish` is handed after the last worker is gone.
 */

import type { EngineHostIdentity } from './contract.ts';
import type { EngineAppInfo, EngineCleanupContext } from './index.ts';

/**
 * What `prepare` learned that the run must honour. `workers` replaces the
 * engine's declared cap for this target and run: the surfaces the engine
 * actually provisioned, `1` to `info.slots`. Declared `workers` stays the
 * static answer for engines that know it up front.
 */
export interface EnginePrepareResult {
  /** Lowers the target's worker cap for this run, `1` to `info.slots`. */
  readonly workers?: number;
  /**
   * Variables every worker of this target is spawned with, on top of the
   * run's environment: how a runner-side `prepare` hands what it provisioned
   * (a device pool it discovered) to each worker's `init`. The run's own
   * variables win on a clash.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Facts handed to `prepare`, once per run and target in the runner process,
 * before any worker exists.
 */
export interface EnginePrepareInfo extends EngineHostIdentity {
  /** The run id. */
  readonly runId: string;
  /** The target being prepared. */
  readonly targetName: string;
  /** Directory relative paths in the config resolve against; see `EngineInitInfo.projectRoot`. */
  readonly projectRoot: string;
  /** The app the target declares, as `init` receives it: what a device installs or warms up here. */
  readonly app: EngineAppInfo;
  /**
   * The worker slots the run will start for this target, `0` to `slots - 1`:
   * the run's worker cap, the engine's declared `workers`, and the work units
   * selected for the target, whichever is smallest; `0` when nothing runs on
   * it while another target has work. A run with nothing to run prepares no
   * target. Provision for exactly these slots (boot that many devices of a
   * pool); `init` then finds them ready.
   */
  readonly slots: number;
  /**
   * The run's environment: what every worker is started with. A host may hand
   * the run an environment other than the runner process's own, so anything
   * provisioned here that a worker later looks up by environment (a browser
   * cache location) must be resolved and spawned against this, not
   * `process.env`.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Aborts on interrupt only. Provisioning has no budget: a first-run
   * download is as long as the network makes it, and cutting it short would
   * fail every test behind it.
   */
  readonly signal: AbortSignal;
  /** Whether the run asked for a visible surface (`--headed`), as `EngineInitInfo` declares it. */
  readonly headed: boolean;
  /**
   * The device `e2e run --device` names for this target, by name or id: the
   * one to bind instead of the configured one. Only an engine that declares
   * `selectsDevice` receives it.
   */
  readonly device?: string;
  /**
   * Reports one line of progress. The runner streams it as a `notice` run
   * event, so it reaches the reporter and every host sink instead of being
   * written to a worker's stderr underneath the live status block.
   */
  readonly log: (line: string) => void;
}

/** Handed to `finish`, once per run and target after the last worker is gone, with the cleanup budget of one hook. */
export interface EngineFinishInfo extends EngineCleanupContext, EngineHostIdentity {
  /** The run id. */
  readonly runId: string;
  /** The target being finished. */
  readonly targetName: string;
  /** The run's environment, the same `prepare` saw. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Reports one line of progress, streamed as a `notice` run event like `prepare`'s. */
  readonly log: (line: string) => void;
}
