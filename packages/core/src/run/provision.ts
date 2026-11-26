/**
 * What a run and a standalone attempt both do before the first engine
 * session: grade each target against its engine declaration, run the
 * engines' `prepare` hooks, and start the app commands the targets declare.
 * One owner, so the dev-loop session (`e2e mcp`) and a test run can never
 * provision differently.
 */

import { engineAppInfo, returnedEnv } from '../config/app.ts';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { EnginePrepareResult } from '../engine/index.ts';
import { ENGINE_SPI_VERSION, type EngineSpiVersion } from '../engine/contract.ts';
import type { DebugTrace } from '../internal/debug.ts';
import { ConfigurationError, errorMessage, InfrastructureError, isE2EError, translateProvisioningError } from '../internal/errors.ts';
import { Deadline, NEVER_ABORTS, sleep, withScopedBudget } from '../internal/time.ts';
import { portOf } from '../internal/urls.ts';
import { isRetryMode, pairRecording, recordsOnSomeAttempt, type RecordingKind, type ResolvedRecording } from '../internal/recording-modes.ts';
import type { RecordingMode } from '../types.ts';
import { declaredCommands } from './declared-processes.ts';
import { DEFAULT_STARTUP_TIMEOUT_MS, ManagedProcess, type AppProcesses, type ManagedProcessHooks } from './managed-process.ts';
import { UNSHARED, type ProcessPool } from './process-pool.ts';

/** What grading reads of one test-target pair a run selected. */
export interface GradedPair {
  readonly disposition: string;
  readonly target: ResolvedTarget;
  readonly test: { readonly titlePath: readonly string[]; readonly file: string };
  readonly options: { readonly trace: RecordingMode | undefined; readonly video: RecordingMode | undefined; readonly retries: number };
}

export interface TargetProvenance {
  engine: { name: string; version: string; spiVersion: EngineSpiVersion };
  capabilities: string[];
  /** What the engine can capture: screenshots (a failure's among them), a video. */
  artifactCapabilities: ('screenshot' | 'video')[];
  stateCapability: boolean;
}

/**
 * What a target's engine declaration says about it: the one description the
 * runner grades against and the report records. A target without an engine is
 * agent-tools-only and honestly reports no capabilities.
 */
export function describeTarget(target: ResolvedTarget): TargetProvenance {
  const engine = target.engine;
  const artifactCapabilities: TargetProvenance['artifactCapabilities'] = [];
  if (engine?.artifacts !== undefined) {
    artifactCapabilities.push('screenshot');
    if (engine.artifacts.startVideo !== undefined) artifactCapabilities.push('video');
  }
  return {
    engine: {
      name: engine?.name ?? 'none',
      version: engine?.version ?? 'unversioned',
      spiVersion: engine?.spiVersion ?? ENGINE_SPI_VERSION,
    },
    capabilities: [...(engine?.capabilities ?? [])].toSorted(),
    artifactCapabilities,
    stateCapability: engine?.state !== undefined,
  };
}

/** A target graded against its engine declaration, before any test starts. */
export interface EngineGrade {
  readonly provenance: TargetProvenance;
  /**
   * Whether a run-wide video mode (the config root, `--video`) asks this
   * target for a video its engine cannot record. It is skipped, and the run
   * says so once (`recordingNotices`). The trace is the runner's own, on every
   * engine, so only the video is graded.
   */
  readonly videoSkipped: boolean;
}

/**
 * Grades one target from its engine declaration and validates the video
 * against it. The video is graded from what will record: with the target's
 * `pairs` (a run), every test that runs and whose mode records on some
 * attempt; without them (a standalone attempt), the target's own mode. A mode
 * a target or a test set is required, so an engine that cannot record it
 * fails here, before any test starts; a run-wide mode applies where the
 * engine can record and is skipped with a notice elsewhere, and a default
 * one is skipped quietly.
 */
export function validateEngine(target: ResolvedTarget, pairs?: readonly GradedPair[]): EngineGrade {
  const provenance = describeTarget(target);
  if (provenance.artifactCapabilities.includes('video')) return { provenance, videoSkipped: false };
  const asked: { readonly recording: ResolvedRecording; readonly pair?: GradedPair }[] =
    pairs === undefined
      ? recordsOnSomeAttempt(target.video.mode, 0) ? [{ recording: target.video }] : []
      : pairs.flatMap((pair) => {
          const recording = pairRecording(pair, 'video');
          return pair.disposition === 'run' && recordsOnSomeAttempt(recording.mode, pair.options.retries) ? [{ recording, pair }] : [];
        });
  const required = asked.find(({ recording }) => recording.source === 'target' || recording.source === 'test');
  if (required !== undefined) {
    const where = `target "${target.name}" (engine ${provenance.engine.name}) cannot record video`;
    const setBy =
      required.recording.source === 'test' && required.pair !== undefined
        ? `test "${required.pair.test.titlePath.join(' > ')}" in ${required.pair.test.file} sets`
        : 'the target sets';
    throw new ConfigurationError('UNSUPPORTED_ARTIFACT', `${where}, and ${setBy} video: '${required.recording.mode}'`);
  }
  return { provenance, videoSkipped: asked.some(({ recording }) => recording.source === 'run') };
}

/**
 * The plan-time notices about what the run asked for and will not capture:
 * one naming every target whose engine cannot record the video a run-wide
 * mode asked of it, and one per kind when tests that would capture it run
 * under a retry mode with no retries, so no attempt of theirs does.
 * `explore` is a run of one attempt no config can retry, so its notice says
 * to pass the flag instead of setting retries.
 */
export function recordingNotices(
  perTarget: readonly { readonly target: ResolvedTarget; readonly pairs: readonly GradedPair[] }[],
  grades: ReadonlyMap<string, EngineGrade>,
  options: { readonly explore?: boolean } = {},
): string[] {
  const notices: string[] = [];
  const skipped = perTarget.filter(({ target }) => grades.get(target.name)?.videoSkipped === true);
  if (skipped.length > 0) {
    const names = skipped.map(({ target }) => `"${target.name}" (engine ${grades.get(target.name)!.provenance.engine.name})`);
    notices.push(
      `video records only on targets whose engine can record it; ${names.length === 1 ? 'target' : 'targets'} ${names.join(', ')} record${names.length === 1 ? 's' : ''} no video`,
    );
  }
  const recordsVideo = (target: ResolvedTarget): boolean => grades.get(target.name)?.provenance.artifactCapabilities.includes('video') === true;
  const trace = retryOnlyNotice('trace', perTarget, () => true, options.explore === true);
  const video = retryOnlyNotice('video', perTarget, recordsVideo, options.explore === true);
  return [...notices, ...(trace === undefined ? [] : [trace]), ...(video === undefined ? [] : [video])];
}

/**
 * The notice for one kind when tests that can capture it (`captures`, by
 * target) run under a retry mode with `retries: 0`: no attempt of theirs
 * captures one. Undefined when no such test runs.
 */
function retryOnlyNotice(
  kind: RecordingKind,
  perTarget: readonly { readonly target: ResolvedTarget; readonly pairs: readonly GradedPair[] }[],
  captures: (target: ResolvedTarget) => boolean,
  explore: boolean,
): string | undefined {
  const modes = new Set<string>();
  let uncaptured = 0;
  for (const { target, pairs } of perTarget) {
    if (!captures(target)) continue;
    for (const pair of pairs) {
      const { mode } = pairRecording(pair, kind);
      if (pair.disposition !== 'run' || !isRetryMode(mode) || pair.options.retries > 0) continue;
      modes.add(`'${mode}'`);
      uncaptured += 1;
    }
  }
  if (uncaptured === 0) return undefined;
  const plural = kind === 'trace' ? 'traces' : 'videos';
  const asked = `${kind}: ${[...modes].join(' and ')} records retries only`;
  if (explore) return `${asked}, and explore runs its goal once, so no ${plural} will be recorded; pass --${kind} on`;
  const tests = uncaptured === 1 ? 'test runs' : 'tests run';
  return `${asked}, and ${uncaptured} ${tests} with retries: 0, so no ${plural} will be recorded for ${uncaptured === 1 ? 'it' : 'them'}; set retries, or ${kind}: 'on'`;
}

export interface PrepareScope {
  readonly runId: string;
  /** The `launch()` host preparing its target; see `EnginePrepareInfo.hostId`. */
  readonly hostId?: string | undefined;
  /** The config's directory, where an engine resolves a relative option (a build path). */
  readonly projectRoot: string;
  /** The same `env` the workers are started with: what prepare provisions must be where a launch will look for it. */
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  /** Whether the run asked for a visible surface, so a hook provisions for the browser it will launch. */
  readonly headed: boolean;
  /** The device `e2e run --device` names, and the one target it binds. */
  readonly device?: { readonly target: string; readonly name: string } | undefined;
  /** Where a hook's progress lines go, under the target they concern. */
  readonly notice: (targetName: string, line: string) => void;
}

export interface FinishScope {
  readonly runId: string;
  readonly hostId?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  /** The cleanup budget every prepared target shares. */
  readonly timeoutMs: number;
  readonly notice: (targetName: string, line: string) => void;
  /** Takes every failure; none skips another target's release. */
  readonly onFailure: (cause: unknown) => void;
}

/**
 * The prepare/finish pairing of a run or a standalone attempt, in one place:
 * every target whose `prepare` hook was called gets its `finish`, whatever
 * happened in between, so what a hook acquired before it failed is still
 * released. Both entry points hold one of these instead of re-deriving the
 * protocol.
 */
export class PreparedEngines {
  private readonly targets: ResolvedTarget[] = [];

  /**
   * Runs one target's `prepare` hook for `slots` worker slots, streaming its
   * progress lines as notices. Resolves to nothing when the engine declares
   * no hook. Callers run targets in turn: two engines provisioning the same
   * toolchain would race, and the notices of one download read better than
   * two interleaved.
   */
  async prepare(target: ResolvedTarget, slots: number, scope: PrepareScope): Promise<EnginePrepareResult | void> {
    const engine = target.engine;
    if (engine?.prepare === undefined) return;
    // Registered before the hook runs: a `prepare` that throws part-way still gets its `finish`.
    this.targets.push(target);
    try {
      return await engine.prepare({
        runId: scope.runId,
        targetName: target.name,
        ...(scope.hostId === undefined ? {} : { hostId: scope.hostId }),
        projectRoot: scope.projectRoot,
        headed: scope.headed,
        ...(scope.device?.target === target.name ? { device: scope.device.name } : {}),
        app: engineAppInfo(target.app),
        slots,
        env: scope.env,
        signal: scope.signal,
        log: (line) => scope.notice(target.name, line),
      });
    } catch (cause) {
      throw translateProvisioningError(cause, ` while preparing engine ${engine.name} for target "${target.name}"`);
    }
  }

  /**
   * Runs the `finish` hook of every prepared target, all at once under one
   * cleanup deadline: releases are independent, and a run should not wait
   * one budget per target. Each hook is bounded like engine disposal: it is
   * never cancelled by an interrupt, and one that ignores its signal is
   * abandoned at the deadline with `CLEANUP_TIMEOUT`.
   */
  async finish(scope: FinishScope): Promise<void> {
    const deadline = new Deadline(scope.timeoutMs);
    await Promise.all(
      this.targets.splice(0).map(async (target) => {
        const engine = target.engine;
        if (engine?.finish === undefined) return;
        // A handle's members are bound at `defineEngine`, so the hook travels on its own.
        const { finish } = engine;
        const timeoutMs = deadline.remaining();
        const label = `finishing engine ${engine.name} for target "${target.name}"`;
        const info = { runId: scope.runId, targetName: target.name, ...(scope.hostId === undefined ? {} : { hostId: scope.hostId }), env: scope.env, timeoutMs, log: (line: string) => scope.notice(target.name, line) };
        try {
          await withScopedBudget(
            timeoutMs,
            NEVER_ABORTS,
            () => new InfrastructureError('CLEANUP_TIMEOUT', `${label} timed out`),
            (signal) => finish({ ...info, signal }),
          );
        } catch (cause) {
          scope.onFailure(translateProvisioningError(cause, ` while ${label}`));
        }
      }),
    );
  }
}

/** The hooks the app commands report through; a run narrates each as a setup step. */
export interface ProcessHooks extends Omit<ManagedProcessHooks, 'unexpectedExit'> {
  /** An owned app command exited; every declaring target depends on it. */
  readonly commandExited?: (targetNames: readonly string[], cause: InfrastructureError) => void;
}

/** The values `env` functions read, and the pool that starts or shares each app command. */
type DeclaredProcessOptions = {
  readonly services?: Readonly<Record<string, unknown>> | undefined;
  readonly pool?: ProcessPool | undefined;
};

/**
 * Starts every distinct app command the targets declare, in target order,
 * deduplicated across targets (two browsers on one dev server share one
 * process). Any `env` functions run first with `services`, and their
 * returned variables replace the functions in each command. `pool`
 * decides whether each is started for this call or shared with others that
 * declare it. Nothing more is acquired once `signal` aborted; what was
 * acquired is returned for release either way.
 */
export async function startDeclaredProcesses(
  targets: readonly ResolvedTarget[],
  projectRoot: string,
  hooks: ProcessHooks,
  signal: AbortSignal,
  debug: DebugTrace,
  { services = {}, pool = UNSHARED }: DeclaredProcessOptions = {},
): Promise<AppProcesses> {
  const held: AppProcesses[] = [];
  const processes: AppProcesses = {
    async stop(onFailure) {
      for (const unit of held.splice(0).toReversed()) await unit.stop(onFailure);
    },
  };
  // A cleanup failure after a failed start is a notice at most: the startup failure is the one reported.
  const onCleanupFailure = (failure: unknown): void => hooks.notice?.(`cleanup after a failed start: ${String(failure)}`);

  // Only await when a target has an `env` function. Otherwise, startup
  // reaches `pool.acquire` in the same tick, so an immediate abort still
  // ends the wait there with `CANCELLED`.
  const envs = targets.some((target) => typeof target.app.command?.env === 'function')
    ? await commandEnvs(targets, services, signal)
    : new Map<string, Readonly<Record<string, string>>>();

  if (envs === undefined) {
    return processes;
  }

  try {
    for (const { label, command, readyUrl, key, targetNames } of declaredCommands(targets, envs)) {
      if (signal.aborted) {
        return processes;
      }

      const start = async (scope: AbortSignal): Promise<AppProcesses> => {
        const app = new ManagedProcess(label, command, projectRoot, { readyUrl }, {
          ...hooks,
          ready: (readyLabel, url, durationMs, reused) => {
            // A process the runner didn't start keeps the environment it was
            // started with, so the variables the env function returned never
            // reach it, and a service on a new port goes unseen by the app.
            if (reused && targetNames.some((name) => envs.has(name))) {
              hooks.notice?.(`${label}: the process at ${readyUrl} didn't get the variables from the target's env function. Restart it with them, or give fixed ports to the services it uses`);
            }

            hooks.ready?.(readyLabel, url, durationMs, reused);
          },
          unexpectedExit: (cause) => hooks.commandExited?.(targetNames, cause),
        });

        const stop: AppProcesses['stop'] = async (onFailure) => {
          try {
            await app.stop();
          } catch (cause) {
            onFailure(cause);
          }
        };

        try {
          await debug.time(`app.start(${label})`, () => app.start(scope));
        } catch (cause) {
          await stop(onCleanupFailure);
          throw cause;
        }

        return { stop };
      };

      held.push(await pool.acquire(`${projectRoot}\0command:${key}`, start, signal));
    }

    return processes;
  } catch (cause) {
    // A process that failed to start must not leave the earlier ones running.
    await processes.stop(onCleanupFailure);
    throw cause;
  }
}

/** Sentinel returned when the runner stops waiting for an `env` function. */
const STOPPED = Symbol('stopped');

/** One call of an `env` function, shared by every target that names it. */
type EnvCall = {
  readonly result: Promise<unknown>;
  readonly startedAt: number;
  settledAt?: number;
};

/**
 * Starts one call of an `env` function. A config or infrastructure error the
 * function throws keeps its code. Any other error becomes `INVALID_CONFIG`,
 * since the `env` function is setup code: that includes a test error, like a
 * service call passed a value it can't copy, and an error from a service call
 * (copied back without its code).
 */
function startEnvCall(call: () => unknown, label: string): EnvCall {
  // Run inside `then` so synchronous throws and rejections take the same error path.
  const result = Promise.resolve()
    .then(call)
    .catch((cause: unknown) => {
      throw isE2EError(cause) && cause.category !== 'test' ? cause : new ConfigurationError('INVALID_CONFIG', `${label}.env threw: ${errorMessage(cause)}`, { cause });
    });

  const entry: EnvCall = { result, startedAt: Date.now() };

  const settle = (): void => {
    entry.settledAt = Date.now();
  };

  void result.then(settle, settle);

  return entry;
}

/**
 * Calls each target's `app.command.env` function with `services`.
 * Each distinct function runs once, so targets that share a function share
 * its result. Returned objects are validated like static `env` objects,
 * with `{port}` expanded to each target URL's port.
 *
 * The promise resolves to a map of target names to variables, or
 * `undefined` if `signal` aborts. If a function doesn't return within its
 * command's `startupTimeout`, startup fails with `APP_UNREACHABLE`.
 */
async function commandEnvs(
  targets: readonly ResolvedTarget[],
  services: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<ReadonlyMap<string, Readonly<Record<string, string>>> | undefined> {
  // Each call keeps when it started and when it settled, so every target
  // sharing it is held to its own `startupTimeout` from the start, whatever
  // order the targets come in.
  const calls = new Map<unknown, EnvCall>();
  const envs = new Map<string, Readonly<Record<string, string>>>();

  for (const target of targets) {
    if (signal.aborted) {
      return undefined;
    }

    const { command, readyUrl, base } = target.app;
    const env = command?.env;

    if (command === undefined || readyUrl === undefined || typeof env !== 'function') {
      continue;
    }

    const label = `target "${target.name}" app.command`;
    const call = calls.get(env) ?? startEnvCall(() => env({ services }), label);

    calls.set(env, call);

    const timeoutMs = command.startupTimeout ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const waiting = new AbortController();
    let outcome: { readonly value: unknown } | { readonly cause: unknown } | typeof STOPPED;

    try {
      outcome = await Promise.race([
        call.result.then((value) => ({ value }), (cause: unknown) => ({ cause })),
        sleep(Math.max(0, call.startedAt + timeoutMs - Date.now()), AbortSignal.any([signal, waiting.signal]))
          .catch(() => undefined)
          .then((): typeof STOPPED => STOPPED),
      ]);
    } finally {
      waiting.abort();
    }

    // The function can't be cancelled, so any eventual result is ignored.
    if (signal.aborted) {
      return undefined;
    }

    // A call an earlier target waited on may have settled after this
    // target's own budget ran out.
    if (outcome === STOPPED || (call.settledAt !== undefined && call.settledAt - call.startedAt > timeoutMs)) {
      throw new InfrastructureError('APP_UNREACHABLE', `${label}.env didn't return within ${timeoutMs} ms`);
    }

    if ('cause' in outcome) {
      throw outcome.cause;
    }

    envs.set(target.name, returnedEnv(outcome.value, label, base === undefined ? undefined : portOf(base)));
  }

  return envs;
}
