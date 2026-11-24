/**
 * One worker's desktop session: the macOS app the target declares, driven
 * through agent-desktop's accessibility commands. The app is launched in the
 * background, and every action goes through the accessibility API, so the
 * user's pointer, focus, and typing stay where they are, unless the target
 * opts into physical input with `headed`.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  ConfigurationError,
  EngineError,
  OBSERVED_NAME_LIMIT,
  OBSERVED_TEXT_LIMIT,
  resolveExpression,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type EngineSnapshot,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type SelectOption,
  type SemanticNode,
  type ViewportPoint,
} from '@e2e-dev/core/engine';
import { AGENT_DESKTOP_VERSION, installPinned, pinnedExecutable, pinnedInstalled, resolveExecutable } from './binary.ts';
import { AgentDesktopCli, AgentDesktopFailure, translate } from './cli.ts';
import { toCombo } from './keys.ts';
import { launchArgumentList } from './launch-arguments.ts';
import { ROOT_ID, projectSnapshot, type NodeBinding, type ProjectedScreen, type RawSnapshot, type Rect } from './nodes.ts';
import type { DesktopPlatform, ResolvedDesktopOptions } from './options.ts';
import { encodePng, windowImage } from './png.ts';

const execFileAsync = promisify(execFile);

/** The least budget agent-desktop gets for its own wait, however little the operation has left. */
const MIN_TOOL_MS = 200;

/** How much of an operation's budget is kept back so agent-desktop answers before the process is killed. */
const ANSWER_MARGIN_MS = 400;

/** How often a launch checks whether the app's window can be read yet. */
const LAUNCH_POLL_MS = 100;

/** The environment variable that carries a launch's token into the process it starts. */
const LAUNCH_TOKEN = 'E2E_DESKTOP_LAUNCH';

/** The cause of a launch agent-desktop handed to a copy already running: it started nothing of the engine's. */
const HANDED_OVER = new Error('the launch handed over to a copy already running');

/** How long a quit looks for the process of a launch whose outcome was unknown. */
const PENDING_SETTLE_MS = 3_000;

/** How much of a quit's budget is kept for a killed process to exit. */
const EXIT_WAIT_MS = 500;

/** How long a launch waits for its process to appear, and then for the app's window to become readable, before it reports why it did not. */
const LAUNCH_READY_MS = 10_000;


/**
 * How long agent-desktop may look for an option in a list. A select of an
 * option that exists answers in well under a second; one of an option that
 * does not exist opens the list's menu and waits out the whole deadline.
 */
const SELECT_WAIT_MS = 3_000;

/** How long a menu may take to close after Escape. */
const MENU_CLOSE_MS = 1_000;

/** The cause of an input that was never sent, because the operation's budget ran out first. */
const NOT_SENT = new Error('the operation ran out of budget before anything was sent');

/** The cause of an `open` that exited with an error, or never ran: LaunchServices started nothing. */
const NOT_STARTED = new Error('open started nothing');

/** The cause of a read that found the app's windows but could read none of them. */
const UNREADABLE = new Error('no window of the app could be read');

/** The cause of a read whose window list did not find the app, while its process still runs. */
const UNLISTED = new Error('the window list did not find the running app');

/** The cause of a read of an app that quit since it launched. */
const QUIT = new Error('the app quit');

/** The cause of a screenshot withheld because its secure fields could not be shown masked, which the harness reads as masking it could not prove. */
const UNMASKED = new Error('the secure fields of the screenshot could not be placed');

/** The prefix of every worker's private agent-desktop state directory, which a later run sweeps once its worker is gone. */
const STATE_PREFIX = 'e2e-agent-desktop-';

/** The file in a state directory that names the process that owns it: its id, and on the next line when it started, which tells it from a later process the OS gives the same id. */
const OWNER_FILE = 'owner';

/** What the owner file holds once its worker gave the directory up: a later sweep takes it, though the process that wrote it may still run another worker. */
const ABANDONED = 'abandoned';

/** The file in a state directory that names the app the worker launched and its launch token, so a sweep can quit an app a killed worker left running. */
const APP_FILE = 'app.json';

/** How old a state directory with no owner file must be before a sweep removes it. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The variables of the run's environment the app under test and
 * agent-desktop get, and nothing else: the run's secrets, model keys, and CI
 * tokens never reach a process the runner does not control. `LC_*` passes
 * too. agent-desktop also gets `AGENT_DESKTOP_HOME`, its private state
 * directory, and an app it launches by bundle id inherits that path.
 */
const INHERITED_ENV = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING']);

/** Launch arguments every launch gets first: no window or document the app saved at its last quit comes back. */
const FRESH_STATE_ARGUMENTS = ['-ApplePersistenceIgnoreState', 'YES'];

/** The most text agent-desktop's `type` takes, in UTF-8 bytes (its `MAX_TEXT_LEN`). */
const MAX_TYPE_BYTES = 10_000;

/** How many node bindings stay usable; the oldest go first. */
const MAX_BINDINGS = 4096;

/** Codes a snapshot fails with while the app has no window to read: not launched yet, or still opening. */
const NO_WINDOW_CODES = new Set(['APP_NOT_FOUND', 'WINDOW_NOT_FOUND']);

/** The app-wide `window` list entry agent-desktop prints. */
interface RawWindow {
  readonly id: string;
  readonly title?: string;
  readonly is_focused?: boolean;
  readonly visible?: boolean;
  /** False for a window accessibility cannot read. */
  readonly accessible?: boolean;
  /** True for a window in the Dock, whose controls accessibility still reads. */
  readonly minimized?: boolean;
  readonly app_name?: string;
  readonly pid?: number;
  readonly process_instance?: string;
  readonly bounds?: Rect;
}

/** One running app as `list-apps` prints it. */
interface RawApp {
  readonly name?: string;
  readonly bundle_id?: string;
  readonly pid?: number;
  readonly process_instance?: string;
}

/** One window of the app under test, as `desktop.windows()` lists it. */
export interface DesktopWindow {
  /** agent-desktop's window id, valid while the window stays open. */
  readonly id: string;
  readonly title: string;
  readonly focused: boolean;
}

/** One launch: the app it starts, the token that marks the process, and the app's copies that ran before it (undefined when they could not all be listed). */
interface Launch {
  readonly target: string;
  readonly token: string;
  readonly before: ReadonlySet<number> | undefined;
}

/** What a state directory's launch record keeps: the launch's token, and once the process is shown to be its own, its id and when it started. */
interface LaunchRecord {
  readonly token: string;
  readonly pid?: number;
  readonly started?: string;
}

/** One attempt's bookkeeping. */
interface Attempt {
  readonly artifactsDir: string;
  screenshots: number;
  readonly screen?: (snapshot: EngineSnapshot) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A read that ran out of time, which proves nothing absent: a retryable `NODE_STALE` that says what it could not tell. */
function partialRead(what: string): EngineError {
  return new EngineError('NODE_STALE', `the window was read only in part, as agent-desktop ran out of time, so ${what} cannot be told`, { retryable: true, cause: UNREADABLE });
}

function notActionable(text: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', text, { retryable: false });
}

function unsupported(text: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', text, { retryable: false });
}

function invalidState(text: string): EngineError {
  return new EngineError('INVALID_STATE', text, { retryable: false });
}

/**
 * The operation with one deadline: `timeoutMs` reads what is left of the
 * budget the call started with, so every command an action sends (a select
 * that tries several ways, a type that clears first) shares one budget
 * instead of each getting the whole of it.
 */
function withDeadline(operation: OperationContext): OperationContext {
  const deadline = Date.now() + operation.timeoutMs;
  return {
    ...operation,
    get timeoutMs() {
      return Math.max(0, deadline - Date.now());
    },
  };
}

/** Constrains a caller-supplied artifact label to a safe filename. */
function sanitizeFilename(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'artifact';
}

/** Every query kind an expression uses, in it and in the expressions it is built from. */
function queryKinds(expression: LocatorExpression, kinds = new Set<string>()): Set<string> {
  switch (expression.kind) {
    case 'query':
      kinds.add(expression.query.kind);
      if (expression.scope !== undefined) queryKinds(expression.scope, kinds);
      break;
    case 'filter':
      queryKinds(expression.source, kinds);
      if (expression.has !== undefined) queryKinds(expression.has, kinds);
      if (expression.hasNot !== undefined) queryKinds(expression.hasNot, kinds);
      break;
    case 'index':
    case 'frame':
      queryKinds(expression.source, kinds);
      break;
    case 'union':
      queryKinds(expression.left, kinds);
      queryKinds(expression.right, kinds);
      break;
    default:
      break;
  }
  return kinds;
}

/** The label a select names: a bare string, or `{ label }`; a `value` is a desktop option's label too, since a native list has no other value. */
function optionLabel(option: SelectOption): string {
  if (typeof option === 'string') return option;
  if (option.label !== undefined) return option.label;
  if (option.value !== undefined) return option.value;
  throw unsupported('a desktop list selects an option by its label; select by { index } is not supported');
}

export class DesktopSurface {
  private cli: AgentDesktopCli | undefined;
  private home: string | undefined;
  private app: EngineAppInfo = {};
  private projectRoot = process.cwd();
  /** The app's bundle id or name: the target's `bundleId`, or the bundle id read from its `appPath`. */
  private launchTarget: string | undefined;
  /** Whether the app is launched in the foreground: with `desktop({ headed })`, or a run that asked for a visible surface (`--headed`). Physical input stays with `desktop({ headed })` alone, since the engine declares it when it is created. */
  private foreground = false;
  /** The `.app` bundle an `appPath` names, resolved; the launched process must run from it. */
  private bundle: string | undefined;
  /** The process name agent-desktop reported at launch, which window lookups filter by before they keep the launched process's own. */
  private appName: string | undefined;
  /** The process the engine launched, which it alone quits; another instance of the same app is never touched. */
  private pid: number | undefined;
  /** agent-desktop's identity of that process, which a later process given the same id does not share. */
  private instance: string | undefined;
  /** When that process started, as `ps` prints it, and the token its launch put in its environment: what shows it is still the launch's once the app list no longer shows it. */
  private started: string | undefined;
  private token: string | undefined;
  /**
   * A launch whose outcome is unknown (it timed out, or failed after it may
   * have started the app): its token, so the next quit can still find and
   * end the process it started.
   */
  private pending: Launch | undefined;
  private attempt: Attempt | undefined;
  /** The launch or quit running now, which the next one waits for. */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** The window a test chose with `desktop.useWindow`, which every read and command then uses until the app quits. */
  private chosenWindow: string | undefined;
  /** The window of the newest screen handed to the harness, by observe or locate: the one a point is measured in, the agent's as core hit-tests it, against the newest observation. */
  private pointWindow: string | undefined;
  /** The newest binding of every node id an observation or a locate handed out, newest last. */
  private readonly bindings = new Map<string, NodeBinding>();
  /** The id handed out for each node identity since the app launched; see `projectSnapshot`. */
  private readonly ids = new Map<string, string>();
  private sequence = 0;
  private toolVersion = AGENT_DESKTOP_VERSION;
  /** The run's environment cut to `INHERITED_ENV`: all the app and agent-desktop are given of it. */
  private appEnv: Readonly<Record<string, string>> = {};

  constructor(
    readonly options: ResolvedDesktopOptions,
    readonly platform: DesktopPlatform,
  ) {}

  // --- lifecycle ---

  /** Downloads the pinned agent-desktop once per machine, unless the target names its own. */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult> {
    if (this.options.binary === undefined) await installPinned(info.env, info.signal, info.log);
    // One worker per target: two would share one screen and one app.
    return { workers: 1 };
  }

  async init(info: EngineInitInfo): Promise<void> {
    this.projectRoot = info.projectRoot;
    this.app = info.app;
    // An engine handle can serve one host after another: nothing of the last one's app carries over. A launch it could not settle stays in its launch record, which the sweep below takes.
    this.bundle = undefined;
    this.appName = undefined;
    this.pid = undefined;
    this.instance = undefined;
    this.started = undefined;
    this.token = undefined;
    this.pending = undefined;
    this.forget();
    this.foreground = this.options.headed || info.headed;
    const executable = await resolveExecutable(this.options.binary, info.projectRoot, info.env);
    this.appEnv = inheritedEnv(info.env);
    // agent-desktop keeps the text of plain fields in its state directory: a worker that was killed left its own behind.
    await sweepStateDirectories();
    // A private state directory per worker, named for the process that owns it so a later sweep can tell it was left behind.
    this.home = await mkdtemp(path.join(tmpdir(), STATE_PREFIX));
    const started = await startedAt(process.pid, info.signal);
    await writeFile(path.join(this.home, OWNER_FILE), started === undefined ? String(process.pid) : `${process.pid}\n${started}`);
    // agent-desktop starts the app it launches with its own environment, so it gets the trimmed one too.
    this.cli = new AgentDesktopCli(executable, { ...this.appEnv, AGENT_DESKTOP_HOME: this.home });
    const status = await this.run<{ version?: string; permissions?: Record<string, { state?: string }> }>(['status'], { label: 'agent-desktop status', input: false, signal: info.signal, timeoutMs: 15_000 });
    if (typeof status.version === 'string') this.toolVersion = status.version;
    const accessibility = status.permissions?.accessibility?.state;
    if (accessibility !== undefined && accessibility !== 'granted') {
      throw new EngineError(
        'ENGINE_FAILURE',
        'agent-desktop has no Accessibility permission. In System Settings > Privacy & Security > Accessibility, allow the app that starts e2e (your terminal, IDE, or CI agent), then run again',
        { retryable: false },
      );
    }
    this.launchTarget = await this.resolveLaunchTarget(info.signal);
    info.log(`agent-desktop ${this.toolVersion} on macOS`);
  }

  /**
   * The app's bundle id or name. An `appPath` on macOS is an `.app` bundle,
   * which is what gets launched even when `bundleId` is set too: its
   * `CFBundleIdentifier`, which `list-apps` reports for the process that
   * bundle starts, and which must then equal `bundleId`.
   */
  private async resolveLaunchTarget(signal: AbortSignal): Promise<string | undefined> {
    if (this.app.appPath === undefined) return this.app.bundleId;
    const bundle = path.resolve(this.projectRoot, this.app.appPath);
    const checked = await checkBundle(bundle, this.app.bundleId, signal);
    if ('problem' in checked) throw new EngineError('ENGINE_FAILURE', checked.problem, { retryable: false });
    this.bundle = await realpath(bundle);
    return checked.bundleId;
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.attempt !== undefined) throw invalidState('an attempt is already running on this desktop engine');
    this.attempt = { artifactsDir: context.artifactsDir, screenshots: 0, ...(context.screen === undefined ? {} : { screen: context.screen }) };
    this.forget();
    context.environment({ platform: this.platform, 'agent-desktop': this.toolVersion });
  }

  /**
   * Quits the app the attempt launched, so the next test starts from a
   * closed app as the first one did. A quit that fails is reported, and the
   * engine keeps the process as its own, so `dispose` tries again.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    this.attempt = undefined;
    this.forget();
    await this.quit(context.signal, context.timeoutMs);
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    let quit = false;
    try {
      await this.quit(context.signal, context.timeoutMs);
      quit = true;
    } finally {
      // An app that would not quit, or a launch whose process was never found, stays named in the launch record, which the next run's sweep quits; the text agent-desktop kept of the app's fields goes either way.
      const leftRunning = !quit && (this.pid !== undefined || this.pending !== undefined);
      if (this.home !== undefined) await (leftRunning ? abandon(this.home) : rm(this.home, { recursive: true, force: true })).catch(() => undefined);
      this.home = undefined;
      this.cli = undefined;
      this.attempt = undefined;
      this.forget();
    }
  }

  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const checks: EngineDoctorCheck[] = [];
    const executable = this.options.binary === undefined ? pinnedExecutable(info.env) : path.resolve(info.projectRoot, this.options.binary);
    if (executable === undefined) return [{ id: 'agent-desktop', status: 'fail', message: `agent-desktop has no release for ${process.platform} on ${process.arch}` }];
    if (this.options.binary === undefined ? !(await pinnedInstalled(info.env)) : !existsSync(executable)) {
      checks.push(
        this.options.binary === undefined
          ? {
              id: 'agent-desktop',
              status: 'warn',
              message: `agent-desktop ${AGENT_DESKTOP_VERSION} is downloaded on the first run, to ${executable}; the Accessibility and Screen Recording checks need it, so run e2e doctor again after the first run`,
            }
          : { id: 'agent-desktop', status: 'fail', message: `desktop({ binary }) names ${executable}, which does not exist` },
      );
    } else {
      const cli = new AgentDesktopCli(executable, inheritedEnv(info.env));
      try {
        const status = await cli.run<{ version?: string; permissions?: Record<string, { state?: string }> }>({ args: ['status'], input: false, signal: info.signal, timeoutMs: 15_000, label: 'agent-desktop status' });
        checks.push({ id: 'agent-desktop', status: 'pass', message: `agent-desktop ${status.version ?? 'unknown version'} at ${executable}` });
        const accessibility = status.permissions?.accessibility?.state;
        const screen = status.permissions?.screen_recording?.state;
        checks.push(
          accessibility === 'granted'
            ? { id: 'accessibility', status: 'pass', message: 'Accessibility permission granted' }
            : { id: 'accessibility', status: 'fail', message: 'Allow the app that starts e2e in System Settings > Privacy & Security > Accessibility' },
          screen === 'granted'
            ? { id: 'screen-recording', status: 'pass', message: 'Screen Recording permission granted' }
            : { id: 'screen-recording', status: 'warn', message: 'Screenshots need Screen Recording: allow the app that starts e2e in System Settings > Privacy & Security > Screen Recording' },
        );
      } catch (cause) {
        checks.push({ id: 'agent-desktop', status: 'fail', message: `agent-desktop at ${executable} did not answer: ${(cause as Error).message}` });
      }
    }
    if (info.app.appPath !== undefined) {
      const bundle = path.resolve(info.projectRoot, info.app.appPath);
      // What init checks of the bundle, so a bundle doctor passes is one init accepts.
      const checked = existsSync(bundle) ? await checkBundle(bundle, info.app.bundleId, info.signal) : { problem: `app.appPath ${bundle} does not exist; build the app or fix the path` };
      checks.push('problem' in checked ? { id: 'app-path', status: 'fail', message: checked.problem } : { id: 'app-path', status: 'pass', message: bundle });
    }
    return checks;
  }

  // --- the app ---

  /**
   * `app.open()`: the copy of the app the engine launched is quit, and the
   * app launched fresh, in the background unless `headed` or the run's
   * `--headed`, with the target's
   * launch arguments. A copy the engine did not launch (the developer's own)
   * is left alone, and never read or driven. A launch that failed after the
   * app started still leaves the engine owning the new process, so the end
   * of the attempt quits it.
   */
  async restart(context: OperationContext): Promise<void> {
    // The budget counts from the call, so time spent waiting for another launch or quit is part of it.
    const operation = withDeadline(context);
    await this.serially(() => this.launchFresh(operation));
  }

  /** `restart` once no other launch or quit of this surface is running. */
  private async launchFresh(operation: OperationContext): Promise<void> {
    const target = this.launchTarget;
    if (target === undefined) throw unsupported("launching the app needs the target's app.bundleId or app.appPath");
    // A failed launch that left no process is nothing to clean up before a new one.
    await this.quitNow(operation.signal, operation.timeoutMs, false);
    // Marks the process this launch starts, so it is told apart from every other copy by evidence, never by timing.
    const launch: Launch = { target, token: randomUUID(), before: await this.runningCopies(target, operation) };
    // Written before anything is sent, so the app stays findable by its token if this worker is killed mid-launch or never finds its process.
    await this.writeRecord({ token: launch.token });
    try {
      if (this.bundle === undefined) await this.launchById(launch, operation);
      else await this.openBundle(this.bundle, launch, operation);
    } catch (cause) {
      // A launch agent-desktop refused, or one never sent, started nothing; nor did one handed to a copy already running.
      const refused =
        cause instanceof EngineError && ((cause.cause instanceof AgentDesktopFailure && cause.cause.notDelivered) || cause.cause === HANDED_OVER || cause.cause === NOT_SENT || cause.cause === NOT_STARTED);
      if (this.pid === undefined && !refused) this.pending = launch;
      throw cause;
    }
    // The process now shown to be the launch's, with when it started, so a later run can quit it even when its environment cannot be read, and never a later process given the same id.
    const started = this.pid === undefined ? undefined : await startedAt(this.pid, operation.signal);
    this.started = started;
    this.token = launch.token;
    if (this.pid !== undefined && started !== undefined) await this.writeRecord({ token: launch.token, pid: this.pid, started });
    this.forget();
    await this.windowReadable(operation);
  }

  /** Puts the launch record in the state directory, renamed into place so a worker killed mid-write never leaves half a record. */
  private async writeRecord(record: LaunchRecord): Promise<void> {
    if (this.home === undefined) return;
    const file = path.join(this.home, APP_FILE);
    await writeFile(`${file}.partial`, JSON.stringify(record));
    await rename(`${file}.partial`, file);
  }

  /**
   * The process ids of the app's copies running now. Undefined when
   * agent-desktop listed the apps only in part: then no copy can be shown to
   * be new, and a launch is told by its token alone.
   */
  private async runningCopies(target: string, operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<ReadonlySet<number> | undefined> {
    // agent-desktop matches the app the way its launch does (any case, the localized name too), so every copy the launch could hand over to is listed.
    const { apps, complete } = await this.run<{ apps?: readonly RawApp[]; complete?: boolean }>(['list-apps', '--app', target, '--timeout-ms', String(this.toolBudget(operation))], { label: 'list apps', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs });
    if (complete === false) return undefined;
    return new Set((apps ?? []).filter((app) => typeof app.pid === 'number').map((app) => app.pid!));
  }

  /** Launches an installed app by bundle id or name through agent-desktop, which reports the process it started. */
  private async launchById(launch: Launch, operation: OperationContext): Promise<void> {
    const { target, token } = launch;
    // In the background unless `headed` or the run's `--headed`: otherwise the app never takes the keyboard from whoever is at the Mac.
    const args = ['launch', target, '--no-attach', ...(this.foreground ? ['--activate'] : []), '--timeout', String(this.toolBudget(operation)), `--env=${LAUNCH_TOKEN}=${token}`];
    for (const argument of [...FRESH_STATE_ARGUMENTS, ...launchArgumentList(this.app)]) args.push(`--arg=${argument}`);
    let launched: { app?: string; pid?: number; process_instance?: string };
    try {
      launched = await this.run(args, { label: `launch ${target}`, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs, raw: true });
    } catch (cause) {
      if (cause instanceof AgentDesktopFailure && cause.code === 'APP_NOT_FOUND' && cause.notDelivered) {
        throw new EngineError('ENGINE_FAILURE', `no installed app has the name or bundle id "${target}"; check the target's app.bundleId`, { retryable: false, cause });
      }
      throw translate(cause, `launch ${target}`, true);
    }
    if (typeof launched.pid !== 'number') throw new EngineError('ENGINE_FAILURE', `agent-desktop launched ${target} but reported no process id, so the engine cannot tell its copy from another`, { retryable: false });
    // A launch handed to a copy already running is not this launch's, and is never driven or quit: a process that ran before the launch, or one whose readable environment lacks the token.
    // An unreadable environment (a macOS system app) leaves agent-desktop's report, of a fresh instance it started, standing.
    const carries = await carriesToken(launched.pid, token, operation.signal);
    if (launch.before?.has(launched.pid) === true || carries === false) {
      throw new EngineError('ENGINE_FAILURE', `launching ${target} handed over to a copy already running (process ${launched.pid}), which the engine does not drive or quit; quit that copy and run again`, { retryable: false, cause: HANDED_OVER });
    }
    // With no token to read and no whole list of the copies that ran before, nothing shows the process is new: it may be a copy already running.
    if (carries === undefined && launch.before === undefined) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `launched ${target}, but process ${launched.pid} cannot be shown to be this launch's: its environment cannot be read, and agent-desktop listed the running apps only in part before the launch. The engine does not drive or quit it; run again`,
        { retryable: false, cause: HANDED_OVER },
      );
    }
    this.appName = launched.app ?? target;
    this.pid = launched.pid;
    this.instance = typeof launched.process_instance === 'string' ? launched.process_instance : undefined;
  }

  /**
   * Starts a new process of the `.app` bundle an `appPath` names, by its
   * path: launching by bundle id would let LaunchServices pick another copy
   * with the same id (an installed release, another checkout's build). The
   * process is then found by its launch token among the app's running copies
   * (see `claim`), since `open` reports no process id; one
   * that cannot be found within `LAUNCH_READY_MS` fails the open, and stays
   * pending, so the end of the attempt still looks for it.
   */
  private async openBundle(bundle: string, launch: Launch, operation: OperationContext): Promise<void> {
    if (operation.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `opening ${bundle}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    // `-g` keeps the app in the background unless `headed` or the run's `--headed`; `open` hands the app its own environment, so it runs with the trimmed one.
    const args = [...(this.foreground ? [] : ['-g']), '-n', '--env', `${LAUNCH_TOKEN}=${launch.token}`, bundle, '--args', ...FRESH_STATE_ARGUMENTS, ...launchArgumentList(this.app)];
    try {
      await execFileAsync('open', args, { signal: operation.signal, timeout: operation.timeoutMs, env: this.appEnv });
    } catch (cause) {
      const failure = cause as { code?: unknown; killed?: unknown; stderr?: unknown; message: string };
      // A cancelled open may have started the app all the same: the launch stays pending.
      if (operation.signal.aborted) throw new EngineError('CANCELLED', `opening ${bundle} was cancelled`, { retryable: false, cause });
      // `open` answered that it could not open the bundle (a missing executable, a bad signature), or could not run: nothing started, so there is nothing to look for.
      if ((typeof failure.code === 'number' && failure.killed !== true) || failure.code === 'ENOENT') {
        const reason = typeof failure.stderr === 'string' && failure.stderr.trim() !== '' ? failure.stderr.trim() : failure.message;
        throw new EngineError('ENGINE_FAILURE', `opening ${bundle} failed: ${reason}`, { retryable: false, cause: NOT_STARTED });
      }
      // Stopped by the budget or a cancellation: the app may be starting.
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `opening ${bundle} did not finish: ${failure.message}`, { retryable: false, cause });
    }
    const until = Date.now() + Math.min(operation.timeoutMs, LAUNCH_READY_MS);
    try {
      while ((await this.claim(launch, operation)) !== true) {
        if (Date.now() + LAUNCH_POLL_MS >= until || operation.signal.aborted) {
          throw new EngineError(
            'ACTION_MAY_HAVE_COMMITTED',
            `${bundle} was opened, but no process of ${launch.target} carries this launch's token, so none can be shown to be its own. A build whose environment macOS hides cannot be told from another copy; launch it by app.bundleId instead`,
            { retryable: false },
          );
        }
        await sleep(LAUNCH_POLL_MS, operation.signal);
      }
    } catch (cause) {
      // `open` ran, so the app may be starting whatever went wrong after it: the launch stays pending, and the end of the attempt looks for it.
      if (operation.signal.aborted) throw new EngineError('CANCELLED', `looking for the process ${bundle} started was cancelled`, { retryable: false, cause });
      if (cause instanceof EngineError && cause.code === 'ACTION_MAY_HAVE_COMMITTED') throw cause;
      throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `${bundle} was opened, but looking for its process failed: ${(cause as Error).message}`, { retryable: false, cause });
    }
  }

  /**
   * Takes as the engine's own the running copy of the app this launch
   * started: the one that carries its token in its environment. False when
   * there is none (yet); undefined when agent-desktop listed the apps only
   * in part and none carries the token, which shows nothing: the launch's
   * copy may be among the ones left out. A copy without the token is never
   * taken, not even the one new copy whose environment cannot be read: being
   * new does not show this launch started it, and the developer's own copy
   * may be the one that just started.
   */
  private async claim(launch: Launch, operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<boolean | undefined> {
    const { target, token, before } = launch;
    const { apps, complete } = await this.run<{ apps?: readonly RawApp[]; complete?: boolean }>(['list-apps', '--app', target, '--timeout-ms', String(this.toolBudget(operation))], { label: 'list apps', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs });
    for (const app of apps ?? []) {
      if (typeof app.pid !== 'number') continue;
      // A copy that ran before the launch is never its own, whatever its environment says.
      if (before?.has(app.pid) === true) continue;
      if ((await carriesToken(app.pid, token, operation.signal)) === true) return this.take(app, target, token);
    }
    return complete === false ? undefined : false;
  }

  /** Takes a process shown to carry the launch's token as the engine's own, the token with it, which shows it is still the launch's once the app list leaves it out. */
  private take(app: RawApp, target: string, token: string): true {
    this.appName = app.name ?? target;
    this.pid = app.pid;
    this.instance = app.process_instance;
    this.token = token;
    this.started = undefined;
    return true;
  }

  /**
   * Waits until the launched app's window can be read: a window exists soon
   * after the launch, but its accessibility element can arrive a moment
   * later, and an observation then would show the agent an empty screen. A
   * window that stays unreadable for `LAUNCH_READY_MS` fails the open: every
   * later step would only time out on an empty screen. Any other failure of a
   * read is reported as it is. An app in the background is never brought
   * forward: one that opens no window there (a document-based app opens its
   * first one only when it comes forward) fails the open, and needs `headed`.
   */
  private async windowReadable(operation: OperationContext): Promise<void> {
    const budgetBound = operation.timeoutMs < LAUNCH_READY_MS;
    const deadline = Date.now() + Math.min(operation.timeoutMs, LAUNCH_READY_MS);
    let sawWindow = false;
    // Whether a read finished and listed no window of the app: only that shows it opened none. A read that ran out of time saw nothing.
    let listedNone = false;
    let timedOut = false;
    while (Date.now() < deadline) {
      if (operation.signal.aborted) throw new EngineError('CANCELLED', `opening ${this.appName ?? 'the app'} was cancelled`, { retryable: false });
      let screen: ProjectedScreen | undefined;
      let read = false;
      try {
        // Each read gets what is left of the readiness wait, not of the whole operation, shared by its commands.
        screen = await this.capture(withDeadline({ ...operation, timeoutMs: Math.max(deadline - Date.now(), 0) }));
        read = true;
      } catch (cause) {
        // The last read ran out of budget: the window never became readable in time.
        if (cause instanceof EngineError && cause.code === 'OPERATION_TIMEOUT') {
          timedOut = true;
          break;
        }
        // A window not readable yet, an app the window list missed, or an app that quit, is what this wait looks at below.
        // So is a window replaced while it was read (agent-desktop's root went stale), a retryable read of a window that was there.
        const stale = cause instanceof EngineError && cause.code === 'NODE_STALE' && cause.retryable;
        if (!(cause instanceof EngineError && (stale || cause.cause === QUIT || cause.cause === UNLISTED))) throw cause;
        if (stale && cause.cause !== UNLISTED) sawWindow = true;
      }
      if (screen !== undefined) return;
      if (read) listedNone = true;
      // An app that quit (or crashed) on its own never shows a window.
      if (this.pid !== undefined && !alive(this.pid)) {
        this.forget();
        this.pid = undefined;
        this.instance = undefined;
        this.started = undefined;
        this.token = undefined;
        throw new EngineError('ENGINE_FAILURE', `${this.appName ?? 'the app'} quit right after it launched, before it showed a window`, { retryable: false });
      }
      await sleep(Math.min(LAUNCH_POLL_MS, Math.max(deadline - Date.now(), 0)), operation.signal);
    }
    // The open's own budget ran out first: that is a timeout, not a window that cannot be read.
    if (budgetBound) throw new EngineError('OPERATION_TIMEOUT', `${this.appName ?? 'the app'} launched, but the open ran out of time before its window could be read`, { retryable: false });
    // A locked screen hides every window from accessibility, and can list none or time out: neither read tells it from an app with no window, so macOS is asked.
    if ((await screenLocked(operation.signal, operation.timeoutMs)) === true) {
      throw new EngineError('ENGINE_FAILURE', `${this.appName ?? 'the app'} launched, but the Mac's screen is locked, so no window can be read through accessibility; unlock it and run again`, { retryable: false });
    }
    if (!sawWindow && listedNone && !this.foreground) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `${this.appName ?? 'the app'} launched in the background and opened no window. Some apps, such as document-based ones, show a window only once they come forward; set desktop({ headed: true }) for them, or run with --headed`,
        { retryable: false },
      );
    }
    // In the foreground there is no background to blame: the app listed no window at all, which a locked screen can cause too.
    if (!sawWindow && listedNone) {
      throw new EngineError(
        'ENGINE_FAILURE',
        `${this.appName ?? 'the app'} launched, but listed no window within ${LAUNCH_READY_MS / 1000} s: it may open none (a menu-bar app) or take longer to, or on macOS the screen may be locked`,
        { retryable: false },
      );
    }
    throw new EngineError(
      'ENGINE_FAILURE',
      `${this.appName ?? 'the app'} launched, but its window cannot be read through accessibility${timedOut ? ' (a read ran out of time)' : ''}. On macOS the screen may be locked, or the window may be off screen`,
      { retryable: false },
    );
  }

  /** The windows of the app the engine launched, for the `desktop` fixture; none while it is not running. */
  async windows(signal: AbortSignal, timeoutMs: number): Promise<readonly DesktopWindow[]> {
    const deadline = Date.now() + timeoutMs;
    const windows = await this.ownWindows({ signal, timeoutMs });
    const listed: DesktopWindow[] = [];
    for (const window of windows) listed.push({ id: window.id, title: await this.titleOf(window, signal, deadline), focused: window.is_focused === true });
    return listed;
  }

  /**
   * A window's title. Without Screen Recording permission macOS hides the
   * title the window list reads, and agent-desktop lists the app's name in
   * its place; the window's accessibility root still carries the title, so
   * a title that reads as the app's name is read from there, unless
   * accessibility cannot read the window. A read that fails leaves the title
   * as listed.
   */
  private async titleOf(window: RawWindow, signal: AbortSignal, deadline: number): Promise<string> {
    const listed = window.title ?? '';
    if (window.app_name === undefined || listed !== window.app_name || window.accessible === false) return listed;
    const timeoutMs = deadline - Date.now();
    const raw = await this.run<RawSnapshot>(['snapshot', '--window-id', window.id, '--max-depth', '1', '--timeout-ms', String(this.toolBudget({ timeoutMs }))], { label: 'read window title', input: false, signal, timeoutMs }).catch(() => undefined);
    const title = raw?.tree.name;
    return title === undefined || title.trim() === '' ? listed : title;
  }

  /**
   * `desktop.useWindow()`: reads and acts in the window `id` names from now
   * on, until the app quits, rather than the focused one. With no id, goes
   * back to the focused window.
   */
  async useWindow(id: string | undefined, signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (id !== undefined) {
      const windows = await this.ownWindows({ signal, timeoutMs });
      if (!windows.some((window) => window.id === id)) throw notActionable(`the app has no window ${id}; desktop.windows() lists the ones it has`);
    }
    this.chosenWindow = id;
    // A point taken in the window read before is not in this one's coordinates: the next point action measures from the window now in use.
    this.pointWindow = undefined;
  }

  private chosenClosed(): EngineError {
    return invalidState(`the window desktop.useWindow() chose (${this.chosenWindow ?? ''}) is closed; choose another, or call desktop.useWindow() to go back to the focused one`);
  }

  /** `desktop.closeApp()`: the app quit, as at the end of every test. */
  async closeApp(signal: AbortSignal, timeoutMs: number): Promise<void> {
    await this.quit(signal, timeoutMs);
  }

  /**
   * Runs launches and quits of this surface one at a time: two at once would
   * each launch a copy into the one process id and launch record the engine
   * keeps, and the end of the attempt would quit only one of them.
   */
  private serially<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(run, run);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }

  /** `quitNow` once no other launch or quit of this surface is running. */
  private quit(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return this.serially(() => this.quitNow(signal, timeoutMs));
  }

  /**
   * Quits the app the engine launched, forcefully: a test needs it gone, not
   * asked to save. It is ended by its process id, so another instance of the
   * same app (the developer's own copy) is left alone, and waited for, so the
   * next launch cannot find it still running. The process is looked up
   * first: one that exited on its own, or whose id the OS gave to another
   * process since, is not running any more, and nothing is killed. Until the
   * process is known to be gone, the engine keeps it as its own, so a quit
   * that failed is tried again. A failed launch that turns out to have left
   * no process is reported, so the user can look for a copy by hand, unless
   * `reportMissing` is false, as before a new launch.
   */
  private async quitNow(signal: AbortSignal, timeoutMs: number, reportMissing = true): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pending = this.pending;
    if (this.pid === undefined && pending !== undefined) {
      // A launch whose outcome was unknown: look for the process it started, which may still be registering, under this quit's own budget.
      // Short of the quit's budget by `EXIT_WAIT_MS`, so a process found at the end can still be seen to exit.
      const until = Date.now() + Math.min(Math.max(timeoutMs - EXIT_WAIT_MS, 0), PENDING_SETTLE_MS);
      // The pending launch stays until it is claimed or the wait's last answer found none: an answer that listed the apps in part proves nothing, and a lookup that ran out of time is no answer.
      let lastShowedNone = false;
      while (Date.now() < until && !signal.aborted) {
        const found = await this.claim(pending, { signal, timeoutMs: Math.max(until - Date.now(), 0) }).catch((cause: unknown) => {
          if (cause instanceof EngineError && cause.code === 'OPERATION_TIMEOUT') return 'timeout' as const;
          throw cause;
        });
        if (found === true) break;
        if (found !== 'timeout') lastShowedNone = found === false;
        await sleep(Math.min(LAUNCH_POLL_MS, Math.max(until - Date.now(), 0)), signal);
      }
      if (signal.aborted) throw new EngineError('CANCELLED', `looking for the process a launch of ${pending.target} started was cancelled`, { retryable: false });
      if (this.pid === undefined) {
        // A process carrying the launch's token is its own, whether or not the app list shows it yet.
        const carriers = await processesCarrying(pending.token, signal);
        if (carriers === undefined) {
          throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: looking for its token among the processes failed; quitting tries again`, { retryable: false });
        }
        if (!(await killed(carriers, deadline, signal))) {
          throw new EngineError('ENGINE_FAILURE', `the process a launch of ${pending.target} started did not exit; quitting tries again`, { retryable: false });
        }
        if (carriers.length === 0 && !lastShowedNone) {
          throw new EngineError('ENGINE_FAILURE', `could not tell whether a launch of ${pending.target} started the app: listing the apps ran out of time or listed them only in part; quitting tries again`, { retryable: false });
        }
        this.pending = undefined;
        if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
        if (carriers.length > 0 || !reportMissing) return;
        throw new EngineError('ENGINE_FAILURE', `a launch of ${pending.target} failed, and no process it started was found; if the app is running, quit it by hand`, { retryable: false });
      }
      this.pending = undefined;
    }
    const { pid, instance, appName } = this;
    this.forget();
    if (pid === undefined || appName === undefined) return;
    const { apps, complete } = await this.run<{ apps?: readonly RawApp[]; complete?: boolean }>(['list-apps', '--app', appName, '--timeout-ms', String(this.toolBudget({ timeoutMs }))], { label: `find ${appName}`, input: false, signal, timeoutMs });
    const listed = apps?.some((app) => app.pid === pid && (instance === undefined || app.process_instance === instance)) === true;
    // An inventory that skipped some processes cannot say the app is gone; it stays the engine's, to quit again.
    if (!listed && complete === false) throw new EngineError('ENGINE_FAILURE', `could not tell whether the app (process ${pid}) is still running: agent-desktop listed the apps only in part`, { retryable: false });
    // The list showing the id as another process is evidence it is not the launch's; the list leaving it out is not.
    const reused = instance !== undefined && apps?.some((app) => app.pid === pid && app.process_instance !== instance) === true;
    const running = listed || (!reused && alive(pid) && (await this.stillLaunched(pid, signal)));
    if (running && !(await killed([pid], deadline, signal))) throw new EngineError('ENGINE_FAILURE', `the app (process ${pid}) did not exit`, { retryable: false });
    this.pid = undefined;
    this.instance = undefined;
    this.started = undefined;
    this.token = undefined;
    if (this.home !== undefined) await rm(path.join(this.home, APP_FILE), { force: true }).catch(() => undefined);
  }

  /**
   * Whether a live process the app list left out is still the one the
   * launch started. A complete list leaves out a process macOS no longer
   * presents as an app (one that set its activation policy to prohibited),
   * so its absence does not show it exited: its start time, or else its
   * launch token, does. A process that cannot be looked up throws, and stays
   * the engine's, so a quit tries again and the launch record stays.
   */
  private async stillLaunched(pid: number, signal: AbortSignal): Promise<boolean> {
    const unknown = (): EngineError => new EngineError('ENGINE_FAILURE', `could not tell whether process ${pid}, which the app list no longer shows, is still the app the engine launched; quitting tries again`, { retryable: false });
    if (this.started !== undefined) {
      const now = await startedAt(pid, signal);
      if (now === undefined) {
        if (!alive(pid)) return false;
        throw unknown();
      }
      return now === this.started;
    }
    if (this.token === undefined) throw unknown();
    const carriers = await processesCarrying(this.token, signal);
    if (carriers === undefined) throw unknown();
    return carriers.includes(pid);
  }

  /** Every binding of the screen before: after a launch or a quit, none names a control that still exists. */
  private forget(): void {
    this.pointWindow = undefined;
    this.chosenWindow = undefined;
    this.bindings.clear();
    this.ids.clear();
  }

  /** The node id for an identity: the one it had before, else a new one, never handed out before since the app launched. */
  private idFor(identity: string | undefined): string {
    let id = identity === undefined ? undefined : this.ids.get(identity);
    if (id === undefined) {
      id = `n${(this.sequence += 1)}`;
      if (identity !== undefined) this.ids.set(identity, id);
    }
    return id;
  }

  /**
   * Projects a snapshot of one window, its node identities scoped to that
   * window. An identity of that window a complete snapshot no longer has is
   * retired: a control that went, or now has a look-alike sibling, never
   * passes its id on to another. A snapshot cut short retires only the
   * identities it saw a look-alike take. Another window's identities stay, so
   * its controls keep their ids when it is read again.
   */
  private projectWindow(raw: RawSnapshot, minimized: boolean, interactive: boolean): ProjectedScreen {
    // An interactive read (-i) prunes the tree, a whole one does not: each keeps its own identities, so one never retires the other's ids.
    const scope = `${raw.window?.id ?? ''}|${interactive ? 'i' : 'w'}|`;
    const used = new Set<string>();
    const shared = new Set<string>();
    const screen = projectSnapshot(
      raw,
      (identity) => {
        if (identity === undefined) return this.idFor(undefined);
        const scoped = `${scope}${identity}`;
        used.add(scoped);
        return this.idFor(scoped);
      },
      { minimized, interactive, onLookAlike: (identity) => shared.add(`${scope}${identity}`), priorIdOf: (identity) => this.ids.get(`${scope}${identity}`) },
    );
    // A read that ran out of time saw only part of the window: what it did not reach may still be there, so only an identity it saw a twin take retires.
    const partial = raw.complete === false || raw.truncated === true;
    for (const identity of this.ids.keys()) if (identity.startsWith(scope) && !used.has(identity) && (!partial || shared.has(identity))) this.ids.delete(identity);
    return screen;
  }

  // --- reading the screen ---

  /**
   * One snapshot of a window of the app the engine launched, projected: the
   * window `windowId` names, else the one the test chose (and no other while
   * it is chosen), else the focused one, the visible ones, and the rest, in
   * that order, the first one accessibility can read. `forMask` is a
   * read that only places secure fields: it reads every node even with
   * `snapshot: 'interactive'`, which leaves out a secure node with no action
   * of its own, and hands out no ids, so the ids of the screen the harness
   * holds stay as they are. `whole` reads every node too, with ids, for a
   * locator: a label left out of an interactive read would match nothing,
   * and a negative assertion on it pass. Undefined, an empty screen, before `app.open()`
   * and while the running app has no window; a copy of the app the engine
   * did not launch is never read. A read that fails is no empty screen,
   * which would let a negative assertion pass: an app that quit is
   * `INVALID_STATE`, as is a chosen window that closed, and windows none of
   * which could be read, or none listed while the screen is locked, are a
   * retryable `NODE_STALE`, so a locator reads again until its deadline.
   */
  private async capture(operation: OperationContext, windowId = this.chosenWindow, forMask = false, whole = false): Promise<ProjectedScreen | undefined> {
    const windows = await this.ownWindows(operation, true);
    const chosen = windowId !== undefined && windowId === this.chosenWindow;
    if (chosen && !windows.some((window) => window.id === windowId)) {
      await this.unlessLocked(operation);
      throw this.chosenClosed();
    }
    if (windows.length === 0 && this.pid !== undefined) {
      await this.requireRunning(operation);
      await this.unlessLocked(operation);
    }
    // A window the list no longer has is closed: its identities go, so windows opened and closed one after another do not pile them up.
    const open = new Set(windows.map((window) => window.id));
    for (const identity of this.ids.keys()) if (!open.has(identity.slice(0, identity.indexOf('|')))) this.ids.delete(identity);
    const candidates =
      windowId === undefined
        ? [...windows.filter((window) => window.is_focused === true), ...windows.filter((window) => window.is_focused !== true && window.visible !== false), ...windows.filter((window) => window.is_focused !== true && window.visible === false)]
        : windows.filter((window) => window.id === windowId);
    for (const window of candidates) {
      const args = ['snapshot', '--window-id', window.id, '--include-bounds', '--max-depth', String(this.options.maxDepth), '--timeout-ms', String(this.toolBudget(operation))];
      const interactive = this.options.interactiveOnly && !forMask && !whole;
      if (interactive) args.push('-i');
      try {
        const raw = await this.run<RawSnapshot>(args, { label: 'snapshot', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs, raw: true });
        if (!forMask) return this.projectWindow(raw, window.minimized === true, interactive);
        let scratch = 0;
        return projectSnapshot(raw, () => `mask${(scratch += 1)}`);
      } catch (cause) {
        // A panel accessibility cannot read, or a window that just closed: try the next one.
        if (cause instanceof AgentDesktopFailure && NO_WINDOW_CODES.has(cause.code)) {
          if (chosen) {
            await this.unlessLocked(operation);
            throw this.chosenClosed();
          }
          continue;
        }
        if (cause instanceof AgentDesktopFailure && cause.details.kind === 'window_without_accessibility_element') continue;
        throw translate(cause, 'snapshot', false);
      }
    }
    if (candidates.length === 0) return undefined;
    throw new EngineError(
      'NODE_STALE',
      `no window of ${this.appName ?? 'the app'} could be read through accessibility (on macOS the screen may be locked), or each closed while it was read`,
      { retryable: true, cause: UNREADABLE },
    );
  }

  /**
   * Throws a retryable `NODE_STALE` while the Mac's screen is locked: macOS
   * then lists none of the app's windows, which must not read as a window
   * that closed or an app with none open.
   */
  private async unlessLocked(operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<void> {
    if ((await screenLocked(operation.signal, operation.timeoutMs)) !== true) return;
    throw new EngineError('NODE_STALE', `the Mac's screen is locked, so no window of ${this.appName ?? 'the app'} can be read through accessibility; reading again`, { retryable: true, cause: UNREADABLE });
  }

  /**
   * Throws unless the process the engine launched still runs: its id alone
   * does not show that, since another process can take the id over once the
   * app quits, so the app list must show the same process instance. A list
   * that left copies out shows nothing, and the read is tried again.
   */
  private async requireRunning(operation: Pick<OperationContext, 'signal' | 'timeoutMs'>): Promise<void> {
    const { pid, instance, appName } = this;
    if (pid === undefined) return;
    const quit = (): EngineError => new EngineError('INVALID_STATE', `${appName ?? 'the app'} quit (process ${pid}); open it again with app.open()`, { retryable: false, cause: QUIT });
    if (!alive(pid)) throw quit();
    if (instance === undefined || appName === undefined) return;
    const { apps, complete } = await this.run<{ apps?: readonly RawApp[]; complete?: boolean }>(['list-apps', '--app', appName, '--timeout-ms', String(this.toolBudget(operation))], { label: `find ${appName}`, input: false, signal: operation.signal, timeoutMs: operation.timeoutMs });
    if (apps?.some((app) => app.pid === pid && app.process_instance === instance) === true) return;
    if (complete === false) throw new EngineError('NODE_STALE', `could not tell whether ${appName} still runs: agent-desktop listed the apps only in part`, { retryable: true, cause: UNREADABLE });
    // A complete list leaves out a process macOS no longer presents as an app (a prohibited activation policy), which may come back: while it is still the launch's, the read is tried again.
    const reused = apps?.some((app) => app.pid === pid && app.process_instance !== instance) === true;
    if (!reused && alive(pid) && (await this.stillLaunched(pid, operation.signal))) {
      throw new EngineError('NODE_STALE', `${appName} (process ${pid}) still runs, but agent-desktop does not list it as an app now; reading again`, { retryable: true, cause: UNLISTED });
    }
    throw quit();
  }

  /**
   * The windows of the process the engine launched; none before
   * `app.open()` or after the app quit. agent-desktop lists a running app
   * with no window as an empty list, and answers `APP_NOT_FOUND` only when
   * no running app has the name. `strict` is for a read of the screen,
   * where that answer must not pass for an empty one: an app that quit is
   * `INVALID_STATE`, and one that still runs, which the list missed, a
   * retryable `NODE_STALE`.
   */
  private async ownWindows(operation: Pick<OperationContext, 'signal' | 'timeoutMs'>, strict = false): Promise<readonly RawWindow[]> {
    const { pid, appName } = this;
    if (pid === undefined || appName === undefined) return [];
    let listed: readonly RawWindow[];
    try {
      listed = await this.run<readonly RawWindow[]>(['list-windows', '--app', appName, '--timeout-ms', String(this.toolBudget(operation))], { label: 'list windows', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs, raw: true });
    } catch (cause) {
      if (cause instanceof AgentDesktopFailure && NO_WINDOW_CODES.has(cause.code)) {
        if (!strict) return [];
        await this.requireRunning(operation);
        throw new EngineError('NODE_STALE', `agent-desktop found no running app named ${appName}, though process ${pid} still runs; reading again`, { retryable: true, cause: UNLISTED });
      }
      throw translate(cause, 'list windows', false);
    }
    const { instance } = this;
    return listed.filter((window) => window.pid === pid && (instance === undefined || window.process_instance === instance));
  }

  /** The window of the launched process a command reads or acts in: the one the test chose, else the focused one, else the first visible one. */
  private async ownWindow(operation: OperationContext): Promise<RawWindow | undefined> {
    const windows = await this.ownWindows(operation);
    if (this.chosenWindow !== undefined) return windows.find((window) => window.id === this.chosenWindow);
    return windows.find((window) => window.is_focused === true) ?? windows.find((window) => window.visible !== false) ?? windows[0];
  }

  async observe(context: OperationContext, options: EngineObserveOptions | undefined): Promise<EngineSnapshot> {
    const operation = withDeadline(context);
    const screen = await this.capture(operation);
    if (screen === undefined) {
      return { root: { ref: { id: ROOT_ID, revision: '' }, role: 'window' }, viewport: { width: 0, height: 0 } };
    }
    this.remember(screen.bindings.values());
    let withheld = false;
    const pixels = options?.pixels === true ? await this.pixelsFor(screen, operation).catch((cause: unknown) => {
      // Out of time or cancelled is no screenshot at all, and the observation with it.
      if (cause instanceof EngineError && (cause.code === 'OPERATION_TIMEOUT' || cause.code === 'CANCELLED')) throw cause;
      // A capture that failed (no Screen Recording permission) is no screenshot, as on the mobile engine, not masking that could not be proven.
      withheld = cause instanceof Error && cause.cause === UNMASKED;
      return undefined;
    }) : undefined;
    this.pointWindow = screen.windowId;
    // Pixels withheld for their secure fields still report the regions masked, none, so the harness reads masking it could not prove (MASKING_UNPROVEN), not a missing screenshot.
    return {
      ...this.snapshotOf(screen),
      ...(pixels === undefined ? (withheld ? { maskedRegionCount: 0 } : {}) : { pixels: pixels.pixels, maskedRegionCount: pixels.masked }),
    };
  }

  private snapshotOf(screen: ProjectedScreen): EngineSnapshot {
    const app = this.appName;
    const location = app === undefined ? screen.title : screen.title === undefined ? app : `${app} › ${screen.title}`;
    return {
      root: bounded(screen.root),
      viewport: screen.viewport,
      ...(screen.truncated ? { truncated: true } : {}),
      ...(location === undefined ? {} : { location }),
    };
  }

  async locate(expression: LocatorExpression, context: OperationContext): Promise<readonly SemanticNode[]> {
    // agent-desktop reports no placeholder for a macOS field, so a placeholder query would match nothing, and a negative assertion on it pass.
    if (queryKinds(expression).has('placeholder')) {
      throw unsupported("macOS accessibility reports no placeholder to match; a field with no label is named by its placeholder, so find it with getByRole('textbox', name) or getByLabel(name)");
    }
    const operation = withDeadline(context);
    // A locator reads the whole window whatever `snapshot` says, as on the mobile engine: the interactive read leaves out static text.
    const screen = await this.capture(operation, this.chosenWindow, false, true);
    if (screen === undefined) return [];
    const sink = this.attempt?.screen;
    if (sink !== undefined) {
      try {
        sink(this.snapshotOf(screen));
      } catch {
        // The trace is evidence; a sink that throws never fails the step.
      }
    }
    // A read cut short (by its budget, or at the depth limit) can leave out a match: no match would not prove a control absent, and one would not prove it the only one. The locator reads again until its deadline.
    if (screen.truncated) {
      throw new EngineError(
        'NODE_STALE',
        `the window was read only in part (it ran out of time, or is deeper than the ${this.options.maxDepth} levels a snapshot reads; desktop({ maxDepth }) raises that), so the matches cannot be counted`,
        { retryable: true },
      );
    }
    const matches = resolveExpression(expression, [screen.root]);
    this.pointWindow = screen.windowId;
    this.remember(matches.flatMap((match) => screen.bindings.get(match.ref.id) ?? []));
    return matches;
  }

  // --- acting ---

  private binding(ref: NodeRef): NodeBinding {
    const binding = this.bindings.get(ref.id);
    if (binding === undefined) throw new EngineError('NODE_STALE', `node ${ref.id} is not on the screen`, { retryable: true });
    // A node read before desktop.useWindow() chose another window is not on the screen in use: the harness locates it again there.
    if (this.chosenWindow !== undefined && binding.windowId !== this.chosenWindow) {
      throw new EngineError('NODE_STALE', `node ${ref.id} is in another window than the one desktop.useWindow() chose`, { retryable: true });
    }
    return binding;
  }

  /**
   * Keeps the newest binding of each node: an id names the same control in
   * every snapshot, and the newest snapshot's agent-desktop ref is the one to
   * act on. A control that has since gone keeps its last ref, which
   * agent-desktop refuses as stale.
   */
  private remember(bindings: Iterable<NodeBinding>): void {
    const fresh = new Set<string>();
    for (const binding of bindings) {
      this.bindings.delete(binding.id);
      this.bindings.set(binding.id, binding);
      fresh.add(binding.id);
    }
    // The oldest go first, but never one just read: a screen larger than the cap keeps every node.
    for (const oldest of this.bindings.keys()) {
      if (this.bindings.size <= MAX_BINDINGS) break;
      if (!fresh.has(oldest)) this.bindings.delete(oldest);
    }
  }

  private refOf(binding: NodeBinding, action: string): string {
    if (binding.ref === undefined) throw notActionable(`node ${binding.id} (${binding.role ?? 'unknown'}) is not a control agent-desktop can ${action}`);
    return binding.ref;
  }

  async perform(ref: NodeRef, action: LocatorAction, context: OperationContext): Promise<void> {
    const operation = withDeadline(context);
    if (ref.id === ROOT_ID) {
      // The window is in view unless it is minimized: toHaveScreenshot on a window locator scrolls it into view first.
      if (action.kind === 'scrollIntoView') {
        const shown = await this.capture(operation);
        if (shown === undefined || shown.root.states?.hidden === true) throw notActionable('the window is not on screen (minimized, or closed), so it cannot be brought into view');
        return;
      }
      if (action.kind !== 'swipe') throw notActionable(`the window takes swipe and scrollIntoView only, not ${action.kind}; act on a node`);
      // The root is the window as it is now: read it again, since a locate or a restart may have moved on from the last observation.
      const screen = await this.capture(operation);
      if (screen !== undefined) this.remember(screen.bindings.values());
      const target = screen?.scrollTarget;
      if (target === undefined && screen?.cutShort === true) throw partialRead('what in it scrolls');
      if (target === undefined) throw notActionable('the window has nothing that scrolls');
      await this.scroll(this.binding({ id: target, revision: '' }), action.direction, action.momentum, operation);
      return this.settle(operation);
    }
    const binding = this.binding(ref);
    switch (action.kind) {
      case 'tap':
        await this.refCommand('click', binding, operation);
        break;
      case 'doubleTap':
        // agent-desktop double-clicks with the real pointer only; declared with `headed` alone.
        await this.refCommand('double-click', binding, operation, [], undefined, true);
        break;
      case 'secondaryTap':
        await this.refCommand('right-click', binding, operation);
        break;
      case 'focus':
        await this.refCommand('focus', binding, operation);
        break;
      case 'clear':
        await this.refCommand('clear', binding, operation);
        break;
      case 'check':
      case 'uncheck':
        // agent-desktop reads the live state, so a box already right sends nothing; the observed state may be stale.
        await this.refCommand(action.kind, binding, operation);
        break;
      case 'scrollIntoView':
        // Static text gets no ref to scroll to; agent-desktop marks a node outside the window offscreen, read as hidden, so one not hidden is in view already.
        if (binding.ref === undefined && binding.states?.hidden !== true) break;
        await this.refCommand('scroll-to', binding, operation);
        break;
      case 'hover':
        await this.refCommand('hover', binding, operation, [], undefined, true);
        break;
      case 'fill':
        await this.refCommand('set-value', binding, operation, [], action.value);
        break;
      case 'press': {
        // A key agent-desktop cannot press is refused before focus moves.
        const combo = toCombo(action.key);
        const window = binding.windowId;
        if (window === undefined) throw notActionable(`node ${binding.id} was read in no window to press a key into`);
        await this.refCommand('focus', binding, operation);
        try {
          // The key goes to the process, which hands it to its key window: with another window that could be it, the control's must be the one shown focused.
          // A window on another Space, which agent-desktop lists as not visible, is still the control's: press --headed brings it forward.
          const windows = await this.ownWindows(operation);
          const home = windows.find((candidate) => candidate.id === window);
          if (home === undefined) throw notActionable(`the window node ${binding.id} was read in is gone`);
          if (home.minimized === true) throw notActionable(`the window node ${binding.id} was read in is minimized, so no key reaches it`);
          const rivals = windows.filter((candidate) => candidate.id !== window && candidate.visible !== false && candidate.minimized !== true);
          if (rivals.length > 0 && home.is_focused !== true) {
            throw notActionable(`node ${binding.id} is in a window that cannot be shown to be the app's key window, so the key could land in another window`);
          }
          // Focusing can hand focus on (a dialog it opens): the key goes only when the control still holds it.
          if (!(await this.holdsFocus(binding, window, operation))) throw notActionable(`node ${binding.id} did not keep keyboard focus, so the key would land on another control`);
          await this.sendKey(combo, window, `press ${action.key}`, operation);
        } catch (cause) {
          // The focus already moved: a retry of the whole press would focus the control a second time, which an app's focus handler sees.
          if (cause instanceof EngineError && cause.retryable) {
            throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `press ${action.key}: ${cause.message} (the control was already focused)`, { retryable: false, cause });
          }
          throw cause;
        }
        break;
      }
      case 'selectOption':
        await this.select(binding, optionLabel(action.value), operation);
        break;
      case 'swipe':
        await this.scroll(binding, action.direction, action.momentum, operation);
        break;
      case 'longPress':
      case 'setInputFiles':
      case 'dragTo':
        // Not declared in `actions` (engine.ts), so the harness never sends them; kept exhaustive.
        throw unsupported(`the desktop engine cannot perform ${action.kind}`);
    }
    await this.settle(operation);
  }

  /** The agent reads the screen right after acting, so its actions let the UI settle first; a test's own steps verify with `expect`. */
  private async settle(operation: OperationContext): Promise<void> {
    if (operation.origin === 'agent') await sleep(Math.min(this.options.settleMs, operation.timeoutMs), operation.signal);
  }

  /** One command on a node's ref, failures translated. */
  private async refCommand(command: string, binding: NodeBinding, operation: OperationContext, extra: readonly string[] = [], stdin?: string, headed = false): Promise<void> {
    try {
      await this.tryRef(command, binding, operation, extra, stdin, headed);
    } catch (cause) {
      throw translate(cause, command, true);
    }
  }

  /** One command on a node's ref, a failure left as agent-desktop reported it so a caller can try another way when nothing was sent. */
  private async tryRef(command: string, binding: NodeBinding, operation: OperationContext, extra: readonly string[] = [], stdin?: string, headed = false): Promise<unknown> {
    const args = [command, this.refOf(binding, command), '--timeout-ms', String(this.toolBudget(operation))];
    if (stdin !== undefined) args.push('--stdin');
    if (headed) args.push('--headed');
    // Last, so a value after `--` is never read as a flag.
    args.push(...extra);
    return await this.run(args, { label: command, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs, raw: true, ...(stdin === undefined ? {} : { stdin }) });
  }

  /**
   * Whether the control a binding names holds keyboard focus in a fresh read
   * of its window. A control with an identity keeps its id; a look-alike has
   * a new id in every read, so it is found by role, name, developer id, and place, with as many
   * twins around it as before: a twin that went could have let another take
   * its place.
   */
  private async holdsFocus(binding: NodeBinding, window: string, operation: OperationContext): Promise<boolean> {
    // Read as the binding was: a locator's binding comes from a whole read, an observation's from an interactive one.
    const now = await this.capture(operation, window, false, !binding.interactive);
    // A read that ran out of time gives every control a fresh id, so it cannot tell which one holds focus: that is no lost focus.
    if (now?.cutShort === true) throw partialRead('which control holds focus');
    return [...(now?.bindings.values() ?? [])].some(
      (candidate) =>
        candidate.states?.focused === true &&
        (binding.stable
          ? candidate.id === binding.id
          : candidate.role === binding.role && candidate.name === binding.name && candidate.testId === binding.testId && sameRect(candidate.rect, binding.rect) && candidate.likeness === binding.likeness),
    );
  }

  /**
   * Chooses an option of a list or dropdown with agent-desktop's `select`,
   * never by setting the value, which would put a missing option in an
   * editable combo box as free text: agent-desktop's select does just that
   * for a combo box whose value is settable, so one is refused. A stale ref is `NODE_STALE`, so the
   * harness locates the list again. For a pop-up button agent-desktop opens
   * the menu to find the option; when it cannot, it may leave the menu open,
   * which is closed again here with Escape. A failure after the menu opened
   * stays one that may have chosen something: a menu left open does not show
   * which control opened it, or that the option is missing. A menu Escape
   * cannot close (an app in the background takes no key) is named in the
   * error, since it covers the window for the steps after.
   */
  private async select(binding: NodeBinding, label: string, operation: OperationContext): Promise<void> {
    // An editable combo box takes any text: agent-desktop's select sets its value and reads it back, which a missing option passes as well.
    if (binding.role === 'combobox' && binding.actions.includes('SetValue')) {
      throw unsupported(`this combo box is editable and takes any text, so a select of "${label}" could not tell a missing option from a chosen one; fill() it and check its value`);
    }
    const ref = this.refOf(binding, 'select');
    try {
      await this.run(['select', ref, '--timeout-ms', String(Math.min(this.toolBudget(operation), SELECT_WAIT_MS)), '--', label], { label: 'select', input: true, signal: operation.signal, timeoutMs: operation.timeoutMs, raw: true });
    } catch (cause) {
      // `select` answers ELEMENT_NOT_FOUND for an option it cannot find; a list that is gone is a stale ref.
      if (cause instanceof AgentDesktopFailure && cause.notDelivered && cause.code === 'ELEMENT_NOT_FOUND') throw notActionable(`the list has no option "${label}"`);
      if (cause instanceof AgentDesktopFailure && !cause.notDelivered) {
        const menu = await this.closeOpenMenu(binding.windowId, operation).catch(() => 'unknown' as const);
        if (menu === 'closed') {
          throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `select "${label}": agent-desktop opened the list's menu and could not confirm a choice, so whether "${label}" was chosen is unknown; the list may have no option "${label}". The menu was closed`, { retryable: false, cause });
        }
        if (menu === 'unconfirmed') {
          throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `select "${label}": ${cause.message} (the input may have reached the app). Escape was sent to close the list's menu, but whether it closed could not be told`, { retryable: false, cause });
        }
        if (menu === 'open' || menu === 'refused') {
          const why =
            menu === 'open'
              ? 'Escape did not close it'
              : this.options.headed
                ? 'agent-desktop sent no Escape to close it'
                : "the app's window is not the active one, so no Escape could be sent to close it; desktop({ headed: true }) closes it with Escape";
          throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `select "${label}": ${cause.message} (the input may have reached the app). The list's menu is still open: ${why}`, { retryable: false, cause });
        }
      }
      throw translate(cause, `select "${label}"`, true);
    }
  }

  /**
   * Closes a menu the launched process has open, with Escape: `closed` when
   * one was open and is closed now, `none` when there was none, `open` when
   * one is still open after the Escape, `unconfirmed` when the Escape went
   * but whether the menu closed cannot be told, `refused` when no Escape could be
   * sent (agent-desktop sends a key only to the active window), and
   * `unknown` when it cannot be told whose a menu is (another copy shares
   * the app's name).
   */
  private async closeOpenMenu(window: string | undefined, operation: OperationContext): Promise<'closed' | 'none' | 'open' | 'unconfirmed' | 'refused' | 'unknown'> {
    const { appName, pid } = this;
    if (appName === undefined || pid === undefined || window === undefined) return 'unknown';
    const menus = async (): Promise<number | undefined> => {
      const listed = await this.run<{ pid?: number; surfaces?: readonly { type?: string; unclassified?: readonly string[] }[] }>(['list-surfaces', '--app', appName], { label: 'list surfaces', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs }).catch(() => undefined);
      if (listed?.pid !== pid) return undefined;
      // A window agent-desktop could not check for a menu (a busy app) says so in `unclassified`: whether a menu is open there is unknown, not no.
      if ((listed.surfaces ?? []).some((surface) => surface.unclassified?.includes('menu') === true)) return undefined;
      return (listed.surfaces ?? []).filter((surface) => surface.type?.includes('menu') === true).length;
    };
    const before = await menus();
    if (before === undefined) return 'unknown';
    if (before === 0) return 'none';
    const sent = await this.sendKey('escape', window, 'close menu', operation).then(
      () => 'sent' as const,
      // A failure that may have reached the app is an Escape sent; any other sent nothing.
      (cause: unknown) => (cause instanceof EngineError && cause.code === 'ACTION_MAY_HAVE_COMMITTED' ? ('sent' as const) : ('refused' as const)),
    );
    if (sent === 'refused') return 'refused';
    // A menu takes a moment to close after Escape. The last look decides: one that could not tell leaves it unknown.
    const until = Date.now() + Math.min(MENU_CLOSE_MS, operation.timeoutMs);
    for (;;) {
      // Cancelled, each look fails at once and the wait would never yield: it cannot tell any more.
      if (operation.signal.aborted) return 'unconfirmed';
      const open = await menus();
      if (open === 0) return 'closed';
      if (Date.now() + LAUNCH_POLL_MS >= until) return open === undefined ? 'unconfirmed' : 'open';
      await sleep(LAUNCH_POLL_MS, operation.signal);
    }
  }

  private async scroll(binding: NodeBinding, direction: string, momentum: string | undefined, operation: OperationContext): Promise<void> {
    const amount = momentum === 'fast' ? 10 : momentum === 'slow' ? 2 : 5;
    await this.refCommand('scroll', binding, operation, ['--direction', direction, '--amount', String(amount)]);
  }

  /** Physical pointer input at a point in the window: only with `headed`, and only then declared. */
  async performAt(point: ViewportPoint, action: PointerAction, context: OperationContext): Promise<void> {
    const operation = withDeadline(context);
    // The point is in the observed window's coordinates: find that window where it is now (it may have moved), or the app's own window before any observation.
    const observed = this.pointWindow;
    const target = observed === undefined ? await this.ownWindow(operation) : (await this.ownWindows(operation)).find((candidate) => candidate.id === observed);
    const window = target?.bounds;
    if (target === undefined || window === undefined) throw notActionable('the window the point was taken from is no longer on screen; observe again');
    if (point.x < 0 || point.y < 0 || point.x >= window.width || point.y >= window.height) {
      throw notActionable(`(${point.x}, ${point.y}) is outside the ${window.width}x${window.height} window; a click there would land on another app`);
    }
    // Physical input lands on whatever is frontmost at the point: bring the window forward first.
    await this.run(['focus-window', '--window-id', target.id, '--headed'], { label: 'focus window', input: true, signal: operation.signal, timeoutMs: operation.timeoutMs });
    // Coming forward can move the window (onto another space, out from under the menu bar): the click is measured from where it is now.
    const forward = (await this.ownWindows(operation)).find((candidate) => candidate.id === target.id);
    const focused = forward?.bounds;
    if (forward === undefined || focused === undefined) throw notActionable('the window the point was taken from closed as it was brought forward; observe again');
    // A click carries no window, only screen coordinates: if another window (a sheet, a panel the app raised) took focus as this one came forward, it could be the one under the point.
    if (forward.is_focused !== true) throw notActionable('another window took focus as the window the point was taken from was brought forward, and could be under the point; observe again');
    if (point.x >= focused.width || point.y >= focused.height) {
      throw notActionable(`(${point.x}, ${point.y}) is outside the ${focused.width}x${focused.height} window; a click there would land on another app`);
    }
    // Unrounded: agent-desktop takes fractional points, and rounding could carry a point past the window's edge.
    const xy = `--xy=${focused.x + point.x},${focused.y + point.y}`;
    const args =
      action.kind === 'hover'
        ? ['hover', xy, '--headed']
        : ['mouse-click', xy, '--headed', ...(action.kind === 'doubleTap' ? ['--count', '2'] : []), ...(action.kind === 'secondaryTap' ? ['--button', 'right'] : [])];
    if (action.kind !== 'hover' && action.kind !== 'tap' && action.kind !== 'doubleTap' && action.kind !== 'secondaryTap') {
      throw unsupported(`the desktop engine cannot perform ${action.kind} at a point`);
    }
    await this.run(args, { label: action.kind, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs });
    await this.settle(operation);
  }

  /** The keyboard capability's `type` (declared with `headed` only): keystrokes into the focused field, which a fresh snapshot names. */
  async typeText(text: string, options: { readonly replace: boolean }, context: OperationContext): Promise<void> {
    // What agent-desktop's type refuses, refused before anything is sent: with replace, the select-all and delete would already have emptied the field.
    if (Buffer.byteLength(text, 'utf8') > MAX_TYPE_BYTES) throw notActionable(`agent-desktop types at most ${MAX_TYPE_BYTES} bytes of text at once; this is ${Buffer.byteLength(text, 'utf8')}`);
    if (text.includes('\0')) throw notActionable('agent-desktop cannot type a NUL character');
    const operation = withDeadline(context);
    const screen = await this.capture(operation);
    const focused = screen === undefined ? undefined : [...screen.bindings.values()].find((binding) => binding.ref !== undefined && binding.states?.focused === true);
    // A read that ran out of time may stop short of the focused field: no proof that none has focus.
    if (focused === undefined && screen?.cutShort === true) throw partialRead('which field has keyboard focus');
    if (focused === undefined) throw notActionable('no field has keyboard focus; tap or focus the field first');
    // agent-desktop types only into a control that offers TypeText; a list or button with focus would take the select-all and delete as commands.
    if (!focused.actions.includes('TypeText')) {
      throw notActionable(`the ${focused.role ?? 'control'}${focused.name === undefined ? '' : ` "${focused.name}"`} that has keyboard focus takes no text; tap or focus a text field first`);
    }
    if (options.replace) {
      // Cleared as on a keyboard, select all and then delete: the app's key handlers see it, and a field that takes keys but refuses an accessibility write is cleared too.
      const window = focused.windowId ?? (await this.ownWindow(operation))?.id;
      if (window === undefined) throw this.chosenWindow === undefined ? invalidState('the app is not running; open it with app.open()') : this.chosenClosed();
      await this.sendKey('cmd+a', window, 'select all', operation);
      // The app may move focus on select all: the delete goes only to the field that still holds it.
      await afterChange('delete the selection', async () => {
        if (!(await this.holdsFocus(focused, window, operation))) throw notActionable('the field lost keyboard focus after select all, so no delete was sent');
        await this.sendKey('backspace', window, 'delete the selection', operation);
      });
    }
    // Keystrokes, which only physical input sends: without it agent-desktop sets the text, and the app's key handlers never run.
    const type = (): Promise<unknown> => this.tryRef('type', focused, operation, [], text, true);
    if (options.replace) await afterChange('type', type);
    else await type().catch((cause: unknown) => Promise.reject(translate(cause, 'type', true)));
    await this.settle(operation);
  }

  /** One key to whatever holds focus in the app's window: agent-desktop brings that window forward (`headed`, which declares this) and sends the key to it. */
  async pressKey(key: string, context: OperationContext): Promise<void> {
    const operation = withDeadline(context);
    const combo = toCombo(key);
    const window = await this.ownWindow(operation);
    if (window === undefined) throw this.chosenWindow === undefined ? invalidState('the app is not running; open it with app.open()') : this.chosenClosed();
    await this.sendKey(combo, window.id, `press ${key}`, operation);
    // As after every other agent action: the app reacts to the key before the agent reads the screen again.
    await this.settle(operation);
  }

  /**
   * Sends one key combo to the launched process's window. agent-desktop
   * sends a key to a named window only while that window is active, which
   * an app in the background never is, and refuses it before sending. A key
   * is never sent by the app's name instead: the name does not pin the
   * process, so the key could reach another copy. With `headed`,
   * agent-desktop brings the window forward first.
   */
  private async sendKey(combo: string, window: string, label: string, operation: OperationContext): Promise<void> {
    const call = { label, input: true, signal: operation.signal, timeoutMs: operation.timeoutMs };
    if (this.options.headed) {
      await this.run(['press', combo, '--window-id', window, '--headed'], call);
      return;
    }
    try {
      await this.run(['press', combo, '--window-id', window], { ...call, raw: true });
    } catch (cause) {
      if (cause instanceof AgentDesktopFailure && cause.notDelivered && cause.details.cause === 'exact_window_focus_unconfirmed') {
        throw notActionable(`${label}: agent-desktop sends a key only to the active window, and the app runs in the background, so nothing was sent; set desktop({ headed: true }) to press keys`);
      }
      throw translate(cause, label, true);
    }
  }

  // --- pixels ---

  async screenshot(label: string | undefined, context: OperationContext): Promise<string> {
    const operation = withDeadline(context);
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('screenshot outside an attempt');
    const screen = await this.capture(operation);
    if (screen === undefined) throw invalidState('the app has no window to capture; open it with app.open()');
    const { pixels } = await this.pixelsFor(screen, operation);
    attempt.screenshots += 1;
    const relative = path.join('screenshots', `${String(attempt.screenshots).padStart(3, '0')}-${sanitizeFilename(label ?? 'screenshot')}.png`);
    await mkdir(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    await writeFile(path.join(attempt.artifactsDir, relative), pixels.data);
    return relative;
  }

  /**
   * The window's pixels with every secure field painted over. The fields
   * come from the snapshot taken just before, and the window is read again
   * after the capture: a secure field without bounds, a partial snapshot, or
   * a field that moved in between withholds the image rather than ship it
   * unproven. That is a refusal of policy, `POLICY_DENIED`, as on the mobile
   * engine: the image could hold a credential. A window with no secure field
   * that closed, changed size, or was read in part because the read ran out
   * of time is a capture that failed, and the next one may work.
   */
  private async pixelsFor(observed: ProjectedScreen, operation: OperationContext): Promise<{ pixels: ObservationPixels; masked: number }> {
    if (observed.windowId === undefined) throw notActionable('the observed surface has no window to capture');
    const unmasked = (reason: string): ConfigurationError => new ConfigurationError('POLICY_DENIED', `${reason}, so the screenshot is withheld`, { cause: UNMASKED });
    // The secure fields come from a whole read of the window, never an interactive one, which can leave a secure node out.
    const screen = this.options.interactiveOnly ? await this.capture(operation, observed.windowId, true) : observed;
    if (screen?.windowId === undefined) throw new EngineError('ENGINE_FAILURE', 'the window closed before it could be captured', { retryable: false });
    // The image goes out beside the observed tree: a window that changed size since that read would pair it with the wrong viewport and boxes.
    if (screen.viewport.width !== observed.viewport.width || screen.viewport.height !== observed.viewport.height) {
      throw new EngineError('ENGINE_FAILURE', 'the window changed size between the read and the capture', { retryable: false });
    }
    const secure = screen.secureRects;
    if (secure === undefined) throw unmasked('a secure field on screen has no bounds to mask');
    // A snapshot cut short can leave out a secure field, which would then go unmasked.
    if (screen.truncated) {
      // One that ran out of time and saw no secure field may read whole next time: a capture that failed, not a refusal.
      if (screen.cutShort && secure.length === 0) throw new EngineError('ENGINE_FAILURE', 'the window was read only in part, as agent-desktop ran out of time, so it cannot be shown to hold no secure field', { retryable: false });
      throw unmasked(
        screen.cutShort
          ? 'the snapshot did not read the whole window, so a secure field may be missing from it'
          : `the window is deeper than desktop({ maxDepth }) reads (${this.options.maxDepth} levels), so a secure field may be missing from the read; raise maxDepth`,
      );
    }
    const directory = await mkdtemp(path.join(this.home ?? tmpdir(), 'shot-'));
    try {
      const file = path.join(directory, 'window.png');
      // agent-desktop captures to a file of its own under TMPDIR first, unmasked, which a process killed mid-capture leaves behind: here it is under this directory, removed below.
      const shot = await this.run<{ scale_factor?: number }>(['screenshot', '--window-id', screen.windowId, file], { label: 'screenshot', input: false, signal: operation.signal, timeoutMs: operation.timeoutMs, tmpdir: directory });
      // The snapshot and the capture are two commands: read the window again, and withhold the image if a secure field moved, came, or went between them.
      const after = await this.capture(operation, screen.windowId, true).catch((cause: unknown) => {
        if (cause instanceof EngineError && (cause.code === 'OPERATION_TIMEOUT' || cause.code === 'CANCELLED')) throw cause;
        // The image holds a secure field the read after it could not place: that is masking not proven, not a capture that failed.
        if (secure.length > 0) throw unmasked('the window could not be read again after the capture, so its secure fields cannot be placed');
        throw cause;
      });
      if (after === undefined || after.windowId !== screen.windowId || after.truncated || !sameRects(after.secureRects, secure) || after.viewport.width !== screen.viewport.width || after.viewport.height !== screen.viewport.height) {
        // Only a secure field, seen in either read or possibly below the depth a read stops at, makes this a matter of masking; a read that ran out of time is tried again.
        if (secure.length > 0 || (after !== undefined && ((after.truncated && !after.cutShort) || after.secureRects?.length !== 0))) throw unmasked('the window changed while it was captured, so its secure fields cannot be placed');
        throw new EngineError('ENGINE_FAILURE', 'the window closed or changed size while it was captured', { retryable: false });
      }
      const scale = typeof shot.scale_factor === 'number' && shot.scale_factor > 0 ? shot.scale_factor : 1;
      const raw = new Uint8Array(await readFile(file));
      const expected = { width: Math.round(screen.viewport.width * scale), height: Math.round(screen.viewport.height * scale) };
      const rects: Rect[] = secure.map((rect) => ({ x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale }));
      const image = windowImage(raw, expected, rects);
      if (image === undefined) {
        const mismatch = `the window capture does not match the window's ${expected.width}x${expected.height} pixels`;
        if (rects.length > 0) throw unmasked(`${mismatch}, so its secure fields cannot be placed`);
        throw new EngineError('ENGINE_FAILURE', mismatch, { retryable: false });
      }
      return { pixels: { data: encodePng(image), mediaType: 'image/png', width: image.width, height: image.height, scale }, masked: rects.length };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  // --- plumbing ---

  /** agent-desktop's own wait inside one command: the operation's budget less a margin, so it answers before it is killed. */
  private toolBudget(operation: Pick<OperationContext, 'timeoutMs'>): number {
    return Math.max(operation.timeoutMs - ANSWER_MARGIN_MS, MIN_TOOL_MS);
  }

  /**
   * Runs one command. A failure is translated onto the engine contract
   * unless `raw` asks for agent-desktop's own, which a caller reads to try
   * another way.
   */
  private async run<T>(args: readonly string[], call: { label: string; input: boolean; signal: AbortSignal; timeoutMs: number; stdin?: string; raw?: boolean; tmpdir?: string }): Promise<T> {
    const cli = this.cli;
    if (cli === undefined) throw invalidState('the desktop engine is not initialized');
    // Nothing is sent once the operation's budget is spent: a later rung of a fallback never starts past the deadline.
    if (call.timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', `${call.label}: the operation's budget ran out before it was sent`, { retryable: false, cause: NOT_SENT });
    try {
      return await cli.run<T>({ args, input: call.input, signal: call.signal, timeoutMs: call.timeoutMs, label: call.label, ...(call.stdin === undefined ? {} : { stdin: call.stdin }), ...(call.tmpdir === undefined ? {} : { tmpdir: call.tmpdir }) });
    } catch (cause) {
      if (call.raw === true && cause instanceof AgentDesktopFailure) throw cause;
      throw translate(cause, call.label, call.input);
    }
  }
}

/**
 * Whether a process carries a launch token in its environment, read with
 * `ps -E` (and from `/proc` on Linux, where the unit tests also run).
 * Undefined where the environment cannot be read (a macOS system app, a
 * build signed with the `restrict` flag, a lookup that failed): no evidence
 * either way.
 */
async function carriesToken(pid: number, token: string, signal: AbortSignal): Promise<boolean | undefined> {
  const marker = `${LAUNCH_TOKEN}=${token}`;
  if (process.platform === 'linux') {
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => undefined);
    if (environ === undefined || environ === '') return undefined;
    const entries = environ.split('\0');
    if (entries.includes(marker)) return true;
    return entries.some((entry) => /^(HOME|PATH|USER)=/.test(entry)) ? false : undefined;
  }
  const { stdout } = await execFileAsync('ps', ['-E', '-p', String(pid), '-o', 'command='], { signal }).catch(() => ({ stdout: '' }));
  const words = stdout.split(/\s+/);
  if (words.includes(marker)) return true;
  // macOS hides the environment of a restricted process, and `ps -E` then prints the command alone: that is no evidence either way.
  return words.some((word) => /^(HOME|PATH|USER)=/.test(word)) ? false : undefined;
}

/**
 * The processes whose environment carries a launch token: the app the
 * launch that made it started, whatever its process id. A process whose
 * environment cannot be read is never among them. Undefined when the
 * processes could not be listed, which shows nothing.
 */
async function processesCarrying(token: string, signal: AbortSignal): Promise<number[] | undefined> {
  const marker = `${LAUNCH_TOKEN}=${token}`;
  if (process.platform === 'linux') {
    const entries = await readdir('/proc').catch(() => undefined);
    if (entries === undefined) return undefined;
    const found: number[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const environ = await readFile(`/proc/${entry}/environ`, 'utf8').catch(() => '');
      if (environ.split('\0').includes(marker)) found.push(Number(entry));
    }
    return found;
  }
  const listed = await execFileAsync('ps', ['-E', '-ww', '-ax', '-o', 'pid=,command='], { signal, maxBuffer: 256 * 1024 * 1024 }).catch(() => undefined);
  if (listed === undefined) return undefined;
  return listed.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.includes(marker))
    .map((words) => Number(words[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

/**
 * What `init` needs of an `appPath` bundle: an Info.plist naming the
 * bundle id the launched process is found by, which is the target's
 * `bundleId` when that is set too, and a signature that lets the launch
 * token be read: macOS hides the environment of its own apps and of a build
 * signed with the `restrict` flag, so the copy `open` starts could not be
 * told from another.
 */
async function checkBundle(bundle: string, bundleId: string | undefined, signal: AbortSignal): Promise<{ bundleId: string } | { problem: string }> {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return { problem: `app.appPath ${bundle} is not an app bundle: it has no Contents/Info.plist. Build the app first` };
  // plutil exits with an error when the key is missing or the file is no plist.
  const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { signal }).catch(() => ({ stdout: '' }));
  const declared = stdout.trim();
  if (declared === '') return { problem: `${plist} declares no CFBundleIdentifier` };
  if (bundleId !== undefined && bundleId !== declared) {
    return { problem: `app.bundleId "${bundleId}" is not the CFBundleIdentifier "${declared}" of app.appPath ${bundle}; the build at appPath is what app.open() launches` };
  }
  // codesign prints the signature to stderr, and fails on a bundle that is not signed, which hides nothing.
  const signature = await execFileAsync('codesign', ['-dv', bundle], { signal }).then(
    ({ stderr }) => stderr,
    (cause: { stderr?: unknown }) => (typeof cause.stderr === 'string' ? cause.stderr : ''),
  );
  if (/^Platform identifier=/m.test(signature) || /flags=0x[\da-f]+\([^)]*\brestrict\b/.test(signature)) {
    return {
      problem: `app.appPath ${bundle} is a macOS app or a build signed with the restrict flag, whose environment macOS hides, so the engine cannot tell the copy it opens from another; set app.bundleId "${declared}" and leave out appPath, so agent-desktop's launch reports the process it starts`,
    };
  }
  return { bundleId: declared };
}

/** The run's environment cut to the variables the app and agent-desktop may see (`INHERITED_ENV`, and `LC_*`). */
function inheritedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && (INHERITED_ENV.has(name) || name.startsWith('LC_'))) kept[name] = value;
  }
  return kept;
}

/**
 * Removes the state directories workers left behind: agent-desktop writes
 * the text of plain fields there, and a worker that was killed never
 * removed its own. A directory goes once the process its owner file names
 * is gone, or, with no owner file, once it is a day old. One still in use
 * is never touched. The app such a worker launched and left running is
 * quit too: every process whose environment carries the token its launch
 * record names, and the process the record names when it is still the one
 * that started then. A process shown to be the launch's by neither is left
 * alone. When the processes cannot be looked up, or one does not exit, the
 * record stays, without the field text, for the next run to try again.
 */
async function sweepStateDirectories(): Promise<void> {
  const root = tmpdir();
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(STATE_PREFIX)) continue;
    const directory = path.join(root, entry);
    // A shared temporary directory (`/tmp` when TMPDIR is unset) holds other users' entries too: a record this user did not write names no launch of its own, and its process id must not be killed with this user's rights.
    if (!(await ownDirectory(directory))) continue;
    const ownerText = (await readFile(path.join(directory, OWNER_FILE), 'utf8').catch(() => '')).trim();
    const [ownerId = '', ownerStarted] = ownerText.split('\n');
    const owner = Number(ownerId);
    const stale =
      ownerText === ABANDONED ||
      (Number.isInteger(owner) && owner > 0 ? !(await ownerRuns(owner, ownerStarted)) : await stat(directory).then((info) => Date.now() - info.mtimeMs > ORPHAN_AGE_MS, () => false));
    if (!stale) continue;
    // A record cut short by the kill that left it names no process: the directory still goes.
    const parsed: unknown = await readFile(path.join(directory, APP_FILE), 'utf8').then((text): unknown => JSON.parse(text)).catch(() => undefined);
    const launched = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const signal = AbortSignal.timeout(5_000);
    const owned: number[] = [];
    let known = true;
    if (typeof launched.token === 'string' && launched.token !== '') {
      const carriers = await processesCarrying(launched.token, signal);
      if (carriers === undefined) known = false;
      else owned.push(...carriers);
    }
    const { pid, started } = launched;
    if (typeof pid === 'number' && typeof started === 'string' && alive(pid)) {
      const now = await startedAt(pid, signal);
      // Running, but when it started cannot be read: whether it is the launch's process is unknown.
      if (now === undefined) known = false;
      else if (now === started && !owned.includes(pid)) owned.push(pid);
    }
    const settled = known && (await killed(owned, Date.now() + 2_000, signal));
    await (settled ? rm(directory, { recursive: true, force: true }) : keepOnlyRecord(directory)).catch(() => undefined);
  }
}

/**
 * Whether the worker process an owner file names still runs: one with its id
 * that started when the file says. A start time that cannot be read counts
 * as the same process, so a directory in use is never taken.
 */
async function ownerRuns(pid: number, started: string | undefined): Promise<boolean> {
  if (!alive(pid)) return false;
  if (started === undefined) return true;
  const now = await startedAt(pid, AbortSignal.timeout(5_000));
  return now === undefined || now === started;
}

/** Whether `directory` is a real directory (not a symlink) that belongs to the user this process runs as. */
async function ownDirectory(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) return false;
  return process.getuid === undefined || info.uid === process.getuid();
}

/**
 * Gives up a state directory whose launch record still names an app: only
 * the record stays, and the owner file says the directory has no worker any
 * more, so the next sweep takes it even while this process runs on, as a
 * program that opens one host after another does.
 */
async function abandon(directory: string): Promise<void> {
  await keepOnlyRecord(directory);
  await writeFile(path.join(directory, OWNER_FILE), ABANDONED);
}

/** Removes everything in a state directory but its owner file and launch record: the text agent-desktop kept of the app's fields. */
async function keepOnlyRecord(directory: string): Promise<void> {
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if (entry !== OWNER_FILE && entry !== APP_FILE) await rm(path.join(directory, entry), { recursive: true, force: true });
  }
}

/** Kills each process and waits until all of them exited; false when one still runs at `until`. */
async function killed(pids: readonly number[], until: number, signal: AbortSignal): Promise<boolean> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  while (pids.some((pid) => alive(pid))) {
    if (signal.aborted || Date.now() >= until) return false;
    await sleep(LAUNCH_POLL_MS, signal);
  }
  return true;
}

/**
 * Whether macOS reports the console session's screen locked (ioreg's
 * `CGSSessionScreenIsLocked`); undefined when that cannot be told, off macOS
 * or when ioreg fails. The question runs within the operation's budget: a
 * cancellation or a budget that ran out ends the operation, never passes as
 * an unknown answer that lets a read go on as if unlocked.
 */
async function screenLocked(signal: AbortSignal, timeoutMs: number): Promise<boolean | undefined> {
  if (timeoutMs <= 0) throw new EngineError('OPERATION_TIMEOUT', "asking macOS whether the screen is locked: the operation's budget ran out", { retryable: false });
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ioreg', ['-n', 'Root', '-d1', '-a'], { signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }));
  } catch (cause) {
    if (signal.aborted) throw new EngineError('CANCELLED', 'asking macOS whether the screen is locked was cancelled', { retryable: false, cause });
    if ((cause as { killed?: boolean }).killed === true) throw new EngineError('OPERATION_TIMEOUT', 'asking macOS whether the screen is locked ran out of time', { retryable: false, cause });
    return undefined;
  }
  const match = /<key>CGSSessionScreenIsLocked<\/key>\s*<(true|false)\/>/.exec(stdout);
  return match === null ? undefined : match[1] === 'true';
}

/**
 * When a process started, as `ps` prints it: with its id, what tells it
 * from a later process the OS gives the same id. Undefined when it is not
 * running or `ps` failed.
 */
async function startedAt(pid: number, signal: AbortSignal): Promise<string | undefined> {
  // `lstart` is local time: every reader must print it in one zone, or a run with another TZ takes a live process for a later one.
  const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { signal, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).catch(() => ({ stdout: '' }));
  const text = stdout.trim();
  return text === '' ? undefined : text;
}

/**
 * Runs the input that follows one that already changed the app (a clear
 * before a type): its failure, whatever agent-desktop says it sent, is
 * `ACTION_MAY_HAVE_COMMITTED`, so the step is never repeated as if nothing
 * happened.
 */
async function afterChange(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (cause) {
    throw new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: ${(cause as Error).message} (an earlier command of this step changed the app)`, { retryable: false, cause });
  }
}

/**
 * An observation tree with each field cut at the contract's limit, the end
 * dropped: a name at `OBSERVED_NAME_LIMIT`, text, a value, and a selection at
 * `OBSERVED_TEXT_LIMIT`. The harness reads a field exactly at its limit as
 * one that may have been cut (and redacts a secret it may end with), and one
 * long label can no longer crowd the controls after it out of what the agent
 * reads. `locate` matches on the whole tree, and single-node reads carry the
 * whole value.
 */
function bounded(node: SemanticNode): SemanticNode {
  const cut = (text: string | undefined, limit: number): { readonly text?: string } => (text === undefined ? {} : { text: text.length > limit ? text.slice(0, limit) : text });
  const name = cut(node.name, OBSERVED_NAME_LIMIT).text;
  const text = cut(node.text, OBSERVED_TEXT_LIMIT).text;
  const value = cut(node.value, OBSERVED_TEXT_LIMIT).text;
  const selection = cut(node.selection, OBSERVED_TEXT_LIMIT).text;
  return {
    ...node,
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
    ...(value === undefined ? {} : { value }),
    ...(selection === undefined ? {} : { selection }),
    ...(node.children === undefined ? {} : { children: node.children.map(bounded) }),
  };
}

/** Whether two rects are the same; two missing rects are not. */
function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return a !== undefined && b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether two lists of secure-field rects are the same, in order. */
function sameRects(a: readonly Rect[] | undefined, b: readonly Rect[]): boolean {
  return a !== undefined && a.length === b.length && a.every((rect, index) => {
    const other = b[index]!;
    return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
  });
}

/** Whether a process still runs: it answers signal 0, or exists but belongs to another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
