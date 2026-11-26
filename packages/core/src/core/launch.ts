/**
 * `launch` from `@e2e-dev/core`: drive a browser or a device from plain code, with
 * no test runner, config file, or report. A host is one worker on one engine
 * instance: it prepares the engine, initializes it, and opens sessions on it
 * one at a time. Parallel work is more hosts.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectConfig, type ResolvedConfig, type ResolvedTarget } from '../config/resolve.ts';
import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { SESSION_CONTROLS } from '../engine/manifest.ts';
import { classifyError, ConfigurationError, E2EError, InfrastructureError, serializeError, TestError } from '../internal/errors.ts';
import { rejectUnknownKeys, rejectUnknownOptions } from '../internal/options.ts';
import { MAX_TIMER_MS } from '../internal/time.ts';
import { builtInFixtures, CORE_FIXTURES } from '../run/fixtures.ts';
import { redactOpening } from '../run/redact-opening.ts';
import { processSecrets, registerProviderKeys, sessionLedger, shareStaticSecrets } from '../run/secrecy.ts';
import { targetIdentity } from '../run/sessions.ts';
import { openCoreHost, type StandaloneHost } from '../run/standalone.ts';
import type { StandaloneAttempt } from '../run/standalone-attempt.ts';
import { secretHandle } from '../secrets.ts';
import type { App, Screen, Secret, TargetApp } from '../types.ts';
import { currentGuests, FailureWatch, registerSession, sessionGuest, type SessionGuest } from './internals.ts';
import { closeOnSignals, engineListeners } from './signals.ts';
import { restoredStateFor, SessionState, type StateIdentity } from './state.ts';

/** What every session holds, whatever its engine. */
export interface CoreFixtures {
  /** Semantic queries and the actions on their matches. */
  readonly screen: Screen;
  /** App lifecycle: open, restart, clear state, back, screenshot, recording. */
  readonly app: App;
  /** The engine's platform label: `web`, `ios`, `android`, or an engine's own string. */
  readonly platform: string;
}

/** The app a host drives: what `app.open()` opens on a browser, or launches on a device. */
export type LaunchApp = Pick<TargetApp, 'url' | 'bundleId' | 'appPath' | 'linkBase' | 'identity' | 'launchArguments' | 'permissions'>;

export interface LaunchOptions {
  /** The app: `url` on a browser; `bundleId` or `appPath` on a device, and `linkBase` for `app.open(path)` there. */
  readonly app?: LaunchApp | undefined;
  /**
   * Secret values by name, at least 6 characters each. Fill one through
   * `host.secret(name)`; an agent receives it by name only. The values are
   * redacted from what `screen.tree()` and the agent read, and from the
   * errors this host throws. A locator read such as `textContent()` returns
   * the page's text as it is.
   */
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  /** Shows the browser window; default false. Devices ignore it. */
  readonly headed?: boolean | undefined;
  /**
   * Default timeout of one operation in milliseconds: an action, a wait, a
   * read, and `app.open()` or `app.restart()`. Without it an action, a wait,
   * or a read gets 30000, and an app open or restart 120000. A session
   * changes it with `setDefaultTimeout`. An agent step has its own, `act`'s
   * `timeout`. There is no session deadline.
   */
  readonly timeout?: number | undefined;
  /** Cancels opening the host, and every session and operation on it. Closing still releases what it opened. */
  readonly signal?: AbortSignal | undefined;
  /**
   * Closes the host on SIGINT, SIGTERM, and SIGHUP, so the browser or device
   * session it launched does not outlive the program; default true. The
   * signal is raised again afterwards unless the program listens for it.
   */
  readonly handleSignals?: boolean | undefined;
  /**
   * Where screenshots, downloads, and recordings are written, from `cwd`.
   * Default: a fresh directory under the system temp directory, deleted
   * when the host closes.
   */
  readonly artifactsDir?: string | undefined;
  /** The directory upload paths and relative files resolve against, `artifactsDir` and an agent's cache directory included; default `process.cwd()`. */
  readonly cwd?: string | undefined;
  /** The environment the engine reads; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Progress outside operations: provisioning, downloads, device leases. Must not throw. */
  readonly onNotice?: ((message: string) => void) | undefined;
}

export interface NewSessionOptions {
  /** A state `saveState()` captured, or `SessionState.import()` read, on a host of the same engine, platform, and app. */
  readonly state?: SessionState | undefined;
  /** Cancels opening the session and every operation on it. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One isolated session: a browser context, or the app on a device. Holds
 * `screen`, `app`, `platform`, and what the engine contributes (`browser`,
 * `device`).
 */
export type Session<Fixtures extends object = {}> = CoreFixtures & Fixtures & SessionControls;

/** The methods every session has beside its fixtures. */
export interface SessionControls extends AsyncDisposable {
  /** Captures the session's state (cookies, storage, app data) in memory. Persist it only with `export({ key })`. */
  saveState(): Promise<SessionState>;
  /** The default timeout of operations started from now on, in milliseconds: actions, waits, reads, and app opens and restarts. */
  setDefaultTimeout(timeout: number): void;
  /** Ends the session and cancels the calls still running on it: each fails as `CANCELLED`, an action, wait, or app or agent call naming itself. Idempotent. Throws an `AggregateError` of the failures closing found, such as a cleanup that did not finish. */
  close(): Promise<void>;
}

/** One engine instance, initialized: the owner of the sessions opened on it, one at a time. */
export interface Host<Fixtures extends object = {}> extends AsyncDisposable {
  /** The engine's platform label: `web`, `ios`, `android`, or an engine's own string; its name when it declares none. */
  readonly platform: string;
  /** The handle of a secret passed to `launch`, for `fill` or an agent's params. An unknown name throws `SECRET_UNAVAILABLE`. */
  secret(name: string): Secret;
  /** Opens a session. One at a time: the previous one must be closed. */
  newSession(options?: NewSessionOptions): Promise<Session<Fixtures>>;
  /** Closes the open session, then the engine. Idempotent. Throws an `AggregateError` of the failures closing found. */
  close(): Promise<void>;
}

const LAUNCH_OPTION_KEYS = ['app', 'secrets', 'headed', 'timeout', 'signal', 'handleSignals', 'artifactsDir', 'cwd', 'env', 'onNotice'] as const;
const LAUNCH_APP_KEYS = ['url', 'bundleId', 'appPath', 'linkBase', 'identity', 'launchArguments', 'permissions'] as const satisfies readonly (keyof LaunchApp)[];
const SESSION_OPTION_KEYS = ['state', 'signal'] as const;
/** The finished steps a session keeps, what its agent reads as the steps before its own; a bot's session runs for days. */
const RETAINED_STEPS = 500;
/**
 * Core fixtures omitted from a session: test-scoped fixtures and `services`,
 * which are only started by `e2e run`, `e2e explore`, `e2e mcp`, and
 * `openHost`. Every other built-in fixture is exposed on the session.
 */
const TEST_FIXTURES = new Set([
  ...Object.entries(CORE_FIXTURES).flatMap(([name, fixture]) => (fixture.scope === 'test' ? [name] : [])),
  'services',
]);

/**
 * Launches `engine`: prepares it (a first-run browser download, a device
 * lease), initializes one worker, and returns the host that opens sessions
 * on it. Each `launch` needs its own engine instance: `launch(web())`.
 */
export async function launch<Fixtures extends object = {}>(engine: EngineHandle<Fixtures>, options: LaunchOptions = {}): Promise<Host<Fixtures>> {
  if (!isEngineHandle(engine)) {
    const got = typeof engine === 'function' ? 'a function' : engine === null ? 'null' : typeof engine;
    throw new TestError('INVALID_ARGUMENT', `launch takes an engine as its first argument and got ${got}: call the engine's factory, such as launch(web()) with web from @e2e-dev/web/engine`);
  }
  // Checked before the seat is reserved: a launch these refuse opens nothing the test must answer for.
  rejectUnknownOptions('launch', options, LAUNCH_OPTION_KEYS);
  if (options.app !== undefined) rejectUnknownKeys('launch app', options.app, LAUNCH_APP_KEYS, 'INVALID_ARGUMENT');
  const timeout = options.timeout;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new TestError('INVALID_ARGUMENT', 'launch timeout must be a positive integer number of milliseconds');
  }
  // Resolved before the seat too: it throws for a `cwd` that is no path, or a working directory deleted under the process.
  const projectRoot = path.resolve(options.cwd ?? process.cwd());
  const artifactsDir = options.artifactsDir;
  const ownsArtifacts = artifactsDir === undefined;
  /** The host's output directory, once there is one: a temporary one is made inside the opening, so a failure to make it gives the seat back too. */
  let output: string | undefined;
  const removeOutput = (): Promise<void> => ownsArtifacts && output !== undefined ? rm(output, { recursive: true, force: true }) : Promise.resolve();
  const handlesSignals = options.handleSignals !== false;
  /** Runs an opening, with the signal listeners the engine registers in it marked as the engine's. */
  const opening = async <T>(open: () => Promise<T>): Promise<T> => {
    const mark = handlesSignals ? engineListeners() : () => undefined;
    try { return await redactOpening(open); } finally { mark(); }
  };
  let opened: { readonly config: ResolvedConfig; readonly target: ResolvedTarget; readonly host: StandaloneHost };
  /** Stops sharing the host's secrets with the sessions beside it; set once they are shared. */
  let withdrawSecrets = (): void => undefined;
  /**
   * What the test launching the host offers, when one is, and the host's seat in it: reserved before anything is awaited, so the host is that test's and no later one's.
   * Reserved last, right before the opening: everything that can throw before it throws with no seat to give back.
   */
  const owner = currentGuests();
  const seat = owner?.host();
  try {
    const dir = artifactsDir === undefined ? await mkdtemp(path.join(os.tmpdir(), 'e2e-core-')) : path.resolve(projectRoot, artifactsDir);
    output = dir;
    opened = await opening(async () => {
      const env = options.env ?? process.env;
      // Before the engine prepares with it: a failure there can quote a key only this environment holds.
      registerProviderKeys(env);
      const resolved = resolveProjectConfig(
        {
          // An engine that declares no platform labels its host with its name.
          targets: [{ engine, ...(engine.platform === undefined ? { platform: engine.name } : {}), ...(options.app === undefined ? {} : { app: options.app }) }],
          trace: 'off',
          video: 'off',
          cache: 'off',
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
          ...(timeout === undefined ? {} : { actionTimeout: timeout, assertionTimeout: timeout }),
        },
        { projectRoot, env },
      );
      // Set past resolution, which keeps a run's output inside its project: a host's lives where the program says.
      const config: ResolvedConfig = { ...resolved, output: dir };
      withdrawSecrets = shareStaticSecrets(config.allSecrets);
      const target = config.targets[0]!;
      const notice = options.onNotice;
      const host = await openCoreHost({
        config, target, env, headed: options.headed ?? false,
        // Hosts name their targets alike, so the engine gets a token per host to keep what it holds apart: a device session.
        // Random, so hosts in other processes, worker threads, or copies of this package differ too.
        hostId: randomBytes(12).toString('hex'),
        signal: anySignal(options.signal, seat?.signal),
        ...(notice === undefined ? {} : { notice: (_target: string, message: string) => notice(message) }),
      });
      return { config, target, host };
    });
  } catch (cause) {
    withdrawSecrets();
    // The opening's failure is what the caller meets, not a cleanup's after it, and the seat is settled either way.
    await removeOutput().catch(() => undefined);
    if (seat?.signal.aborted === true) owner?.gaveUp(cause);
    // The caller meets this rejection, so nothing of the opening is left running in the test.
    else seat?.release?.();
    throw cause;
  }
  const { config, target, host } = opened;
  const identity: StateIdentity = {
    engine: target.engine?.name ?? 'none',
    platform: target.platform,
    appIdentity: targetIdentity(target).appIdentity,
    ...(target.app.identity === undefined ? {} : { app: target.app.identity }),
  };
  let closing: Promise<void> | undefined;
  /** Whether the test that launched the host has taken charge of its end. */
  let owned = false;
  /** The open session's close, so the host closes it the way a program would, its agents' recordings settled. */
  let closeOpen: (() => Promise<void>) | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      unregister();
      const errors: { readonly code: string; readonly message: string; readonly category: string }[] = [];
      try {
        await closeOpen?.();
      } catch (cause) {
        errors.push(...(cause instanceof AggregateError ? cause.errors as E2EError[] : [classifyError(cause)]));
      }
      try {
        errors.push(...await host.close());
      } finally {
        // A test that launched the host keeps its secrets shared until the test ends.
        if (!owned) withdrawSecrets();
      }
      await removeOutput().catch(() => undefined);
      throwClosingErrors(errors, 'closing the host');
    })();
    return closing;
  };
  const unregister = handlesSignals ? closeOnSignals(close) : () => undefined;
  // A host a test launched is the test's to end: the attempt closes it if the test does not.
  owned = seat?.take({ close, release: withdrawSecrets }) === true;
  if (seat !== undefined && !owned) {
    await close();
    const gaveUp = new E2EError('infrastructure', 'CANCELLED', 'the test that launched the host ended before it was open');
    owner?.gaveUp(gaveUp);
    throw gaveUp;
  }
  /** Opens one session on the host, for the guest that was decided when the call was made. */
  async function openSession(sessionOptions: NewSessionOptions, guest: SessionGuest): Promise<Session<Fixtures>> {
    rejectUnknownOptions('newSession', sessionOptions, SESSION_OPTION_KEYS);
    if (closing !== undefined) throw new InfrastructureError('WORKER_PROTOCOL', 'the host is closed');
    const state = sessionOptions.state === undefined ? undefined : restoredStateFor(sessionOptions.state, identity);
    const failures = new FailureWatch();
    const attempt = await host.openAttempt({
      signal: anySignal(sessionOptions.signal, guest.signal),
      // No session deadline: each operation keeps its own timeout.
      timeoutMs: MAX_TIMER_MS,
      onProgress: failures.onProgress,
      mirror: guest.mirror,
      // A test that keeps videos keeps one of each session it opens too, when the engine can record it; a program's own session records none.
      ...(guest.recordsVideo ? { video: { keep: 'always', policy: 'best-effort' } as const } : {}),
      cancelsOnClose: {
        closed: () => new E2EError('infrastructure', 'CANCELLED', 'the session is closed'),
        cut: (call) => new E2EError('infrastructure', 'CANCELLED', `the session closed while ${call} was running`),
      },
      // No report stands between an operation's error and the program, so the error itself is classified and redacted.
      redactThrown: true,
      retainSteps: RETAINED_STEPS,
      ...(state === undefined ? {} : { state }),
    });
    failures.watch(attempt.steps);
    const session = coreSession<Fixtures>(attempt, config, identity, target, failures, guest, timeout, () => {
      if (closeOpen === session.close) closeOpen = undefined;
    });
    closeOpen = session.close;
    if (!guest.attach({ root: config.projectRoot, busy: () => attempt.steps.busy, abandonRunning: () => attempt.steps.abandonRunning(), close: session.close })) {
      await session.close();
      throw new E2EError('infrastructure', 'CANCELLED', 'the test that opened the session ended before it was open');
    }
    return session;
  }

  return {
    platform: target.platform,
    secret: (name: string) => {
      const registered = typeof name === 'string' ? config.allSecrets.get(name) : undefined;
      if (registered === undefined) {
        const known = [...config.allSecrets.keys()];
        throw new ConfigurationError('SECRET_UNAVAILABLE', `secret ${JSON.stringify(name)} was not passed to launch; ${known.length === 0 ? 'it was given no secrets' : `it has ${known.join(', ')}`}`);
      }
      return secretHandle({ name, purpose: registered.purpose });
    },
    newSession: (sessionOptions = {}) => {
      const guest = sessionGuest();
      return opening(() => openSession(sessionOptions, guest)).catch((cause: unknown) => {
        guest.failed(cause);
        throw cause;
      });
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}

/** The session over one attempt: its fixtures, and the controls a program needs without a test around it. */
function coreSession<Fixtures extends object>(
  attempt: StandaloneAttempt,
  config: ResolvedConfig,
  identity: StateIdentity,
  target: ResolvedTarget,
  failures: FailureWatch,
  guest: SessionGuest,
  timeout: number | undefined,
  onClosed: () => void,
): Session<Fixtures> {
  const { fixtures } = attempt;
  const engine = attempt.agentRuntime.engine;
  const setDefaultTimeout = (ms: number): void => engine.setDefaultTimeouts({ action: ms, assertion: ms, lifecycle: ms });
  if (timeout !== undefined) setDefaultTimeout(timeout);
  const closers: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const errors = [];
      for (const closer of closers) {
        try { await closer(); } catch (cause) { errors.push(serializeError(classifyError(cause), { phase: 'cleanup', redact: processSecrets.redact })); }
      }
      errors.push(...await attempt.close());
      try { await guest.videos(attempt.videos()); } catch (cause) { errors.push(serializeError(classifyError(cause), { phase: 'cleanup', redact: processSecrets.redact })); }
      onClosed();
      throwClosingErrors(errors, 'closing the session');
    })();
    return closing;
  };
  const controls: SessionControls = {
    // An engine's capture failure reaches the program through the same sanitized boundary as an opening's.
    saveState: () => redactOpening(async () => {
      if (attempt.session.captureState === undefined) {
        throw new ConfigurationError('UNSUPPORTED_CAPABILITY', `engine ${identity.engine} has no state capability, so a session on it cannot be saved`);
      }
      const state = await attempt.session.captureState(engine.operation());
      // Every value the session knows, configured ones too: the state may restore on a host launched without them.
      return SessionState.captured(identity, state, sessionLedger(attempt.session, config.allSecrets).entries());
    }),
    setDefaultTimeout: (ms: number) => {
      if (!Number.isInteger(ms) || ms <= 0) throw new TestError('INVALID_ARGUMENT', 'setDefaultTimeout takes a positive integer number of milliseconds');
      setDefaultTimeout(ms);
    },
    close,
    [Symbol.asyncDispose]: close,
    // Every control is a name `defineEngine` keeps from fixtures, so none can meet a fixture on the session.
  } satisfies Record<(typeof SESSION_CONTROLS)[number] | typeof Symbol.asyncDispose, unknown>;
  // Built property by property: the fixtures are accessors, each acquired on first touch, and their names come from the engine.
  const session = {} as Session<Fixtures>;
  for (const name of builtInFixtures(target).names) {
    if (TEST_FIXTURES.has(name)) continue;
    Object.defineProperty(session, name, { enumerable: true, get: () => Reflect.get(fixtures, name) as unknown });
  }
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(controls));
  const typed = Object.freeze(session);
  registerSession(typed, {
    attempt, config, target, closers,
    // A cancelled session implicates nothing, so its recordings are neither written nor evicted.
    settlement: () => attempt.budget.signal.aborted ? undefined : failures.settlement(attempt.steps),
  });
  return typed;
}

/** A signal that aborts when any of the given ones does; one that never aborts when none is given. */
function anySignal(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const given = signals.filter((signal) => signal !== undefined);
  return given.length === 1 ? given[0]! : AbortSignal.any(given);
}

/** Throws what closing found, redacted, as one `AggregateError`; nothing when it found nothing. */
function throwClosingErrors(errors: readonly { readonly code: string; readonly message: string; readonly category: string }[], what: string): void {
  if (errors.length === 0) return;
  const thrown = errors.map((error) => new E2EError(error.category as E2EError['category'], error.code, error.message));
  throw new AggregateError(thrown, `${what} failed: ${thrown.map((error) => error.message).join('; ')}`);
}
