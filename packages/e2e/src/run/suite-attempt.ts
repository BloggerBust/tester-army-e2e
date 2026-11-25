/**
 * What code that outlives a test runs on: a pass of suite hooks (the
 * `beforeAll` hooks of the scopes a test enters, or the `afterAll` hooks of
 * the scopes it leaves), or the worker fixtures' teardowns.
 *
 * On an engine that isolates each attempt the code sees `platform` and
 * nothing opens. On one whose state outlives an attempt it also sees the
 * engine's fixtures, `app`, and `screen`, from the attempt already open (a
 * serial group's or a hosted test's, since an engine runs one attempt at a
 * time) or from a short attempt of its own. Its steps and artifacts are no
 * test's: a hook that fails is a run error naming its scope.
 */

import { rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedConfig, ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import type { DebugTrace } from '@e2e-dev/core/lib/internal/debug';
import { classifyError, ConfigurationError, E2EError, serializeError, TestTimeoutError, type SerializedError } from '@e2e-dev/core/lib/internal/errors';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { Deadline, withTimeout } from '@e2e-dev/core/lib/internal/time';
import { createAttemptArtifacts } from '@e2e-dev/core/lib/run/artifacts';
import { inSuiteHook, type RunningSuiteHook } from '@e2e-dev/core/lib/internal/test-timeout';
import { AttemptBudget, AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import type { ClosingRecord, SessionClose, SessionPlan } from '@e2e-dev/core/lib/run/engine-sessions';
import { createFixtures, type ArtifactSink } from '@e2e-dev/core/lib/run/fixtures';
import type { RunError } from '@e2e-dev/core/lib/run/records';
import { redactForSession, sessionLedger } from '@e2e-dev/core/lib/run/secrecy';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import type { WorkerModels } from '@e2e-dev/core/lib/run/worker-models';
import { planSuiteHook } from '../collect/fixture-plan.ts';
import type { SuiteHook } from '../collect/registry.ts';
import { attemptBuiltIns, attemptlessBuiltIns, bindFixtures, fixtureSetup, type BuiltInReader, type WorkerFixturePool } from './fixture-pool.ts';
import { runHook, type SuiteHookSession } from './realm.ts';

/** The results directory suite hooks' short attempts write in, left only when one wrote a file there. */
const SUITE_HOOKS_DIR = 'suite-hooks';

/** Executor capabilities a suite attempt borrows. */
export interface SuiteAttemptHost {
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly artifactsRoot: string;
  readonly interruptSignal: AbortSignal;
  readonly debug: DebugTrace;
  readonly workerFixtures: WorkerFixturePool;
  launchSession(plan: SessionPlan, attemptId: string, artifactsDir: string, signal: AbortSignal): Promise<TargetSession>;
  closeSession(session: TargetSession, close: SessionClose, record: ClosingRecord, sink: ArtifactSink, secondaryErrors: SerializedError[]): Promise<void>;
}

/** The executor a suite attempt runs on, and what it does not expose itself. */
export interface SuiteAttemptContext {
  readonly host: SuiteAttemptHost;
  readonly config: ResolvedConfig;
  readonly models: WorkerModels;
  /** Run-level error sink: a launch failure, a failed close, a failed teardown. */
  readonly runErrors: RunError[];
}

/** The attempt the code runs in. */
interface OpenAttempt {
  readonly builtIns: BuiltInReader;
  readonly budget: AttemptBudget;
  readonly steps: StepRecorder;
  close(): Promise<void>;
}

/**
 * Why code runs with no attempt behind it: the engine isolates each attempt,
 * the code names no fixture that needs one, the run was interrupted (a
 * forced attempt would dispose beside the unit's, still open), or the
 * attempt could not open.
 */
type NoAttempt = 'isolated' | 'unnamed' | 'interrupted' | { readonly failure: E2EError };

function isOpen(attempt: OpenAttempt | NoAttempt): attempt is OpenAttempt {
  return typeof attempt === 'object' && 'steps' in attempt;
}

/** The error for built-in `name` when `label` reads it with no attempt behind it, saying why there is none. */
function unavailable(reason: NoAttempt, label: string, engineName: string): (name: string) => Error {
  const refuse = (name: string, because: string): string => `"${name}" is not available to the ${label}: ${because}`;
  if (reason === 'isolated') {
    return (name) => new ConfigurationError('UNSUPPORTED_CAPABILITY', refuse(name, `engine ${engineName} gives each attempt a fresh surface, so nothing of it outlives a test`));
  }
  if (reason === 'unnamed') {
    return (name) => new ConfigurationError('UNSUPPORTED_CAPABILITY', refuse(name, 'it names no engine fixture in its first parameter, so no attempt opened for it'));
  }
  if (reason === 'interrupted') {
    return (name) => new E2EError('interrupted', 'INTERRUPTED', refuse(name, 'the run was interrupted, so no attempt opens for it'));
  }
  const { failure } = reason;
  return (name) => new E2EError(failure.category, failure.code, refuse(name, `the attempt suite hooks run in could not open: ${failure.message}`));
}

/** One pass of code that outlives a test; `shared` is the attempt already open on the engine, which it then runs on. */
export class SuiteAttempt implements SuiteHookSession {
  /** The open attempt, or the launch failure, reported once as a run error, that left the pass without one. */
  private opened: Promise<OpenAttempt | { readonly failure: E2EError }> | undefined;

  constructor(
    private readonly context: SuiteAttemptContext,
    private readonly shared: TargetSession | undefined,
  ) {}

  /**
   * Runs one suite hook with the worker fixtures it names, within
   * `timeoutMs`; `test.setTimeout` in a `beforeAll` moves it, for the
   * fixtures the hook sets up as for the hook.
   */
  async run(hook: SuiteHook, timeoutMs: number): Promise<void> {
    const { host } = this.context;
    const plan = planSuiteHook(host.target, hook);
    const label = `${hook.kind} hook`;
    const running = hook.kind === 'beforeAll' ? { name: 'a beforeAll hook', settable: true } : { name: 'an afterAll hook', settable: false };
    await this.within(label, timeoutMs, plan.usesEngine, running, async (builtIns, owns) => {
      const bound = bindFixtures({ plan, builtIns, pool: host.workerFixtures });
      await bound.setUp((fixture) => owns(fixtureSetup(fixture)));
      owns(`the ${label}`);
      await bound.call(hook);
    });
  }

  /**
   * Runs `body` within `timeoutMs`, on an attempt when it `usesEngine` and
   * one can open. When none can, the code still runs, so an `afterAll` that
   * needs no device and a worker fixture's teardown are not skipped; reading
   * a built-in that needs an attempt then fails with the reason. The steps
   * `body` starts are `label`'s unless it says otherwise through `owns`
   * (`StepRecorder.owner`). `running` names the code to `test.setTimeout`,
   * which moves the timeout, the attempt's budget with it, only when it is
   * `settable`.
   */
  async within(
    label: string,
    timeoutMs: number,
    usesEngine: boolean,
    running: { readonly name: string; readonly settable: boolean },
    body: (builtIns: BuiltInReader, owns: (owner: string) => void) => Promise<void>,
  ): Promise<void> {
    const { host, config } = this.context;
    const acquired = await this.acquire(usesEngine);
    const attempt = isOpen(acquired) ? acquired : undefined;
    const builtIns = isOpen(acquired) ? acquired.builtIns : attemptlessBuiltIns(host.target, unavailable(acquired, label, host.target.engine?.name ?? 'none'));
    const hookAbort = attempt?.budget.enter(host.interruptSignal, timeoutMs) ?? new AbortController();
    // On the attempt's budget, so the device calls the code makes stop at the deadline `test.setTimeout` moved.
    const budget = attempt?.budget ?? new AttemptBudget(AbortSignal.any([host.interruptSignal, hookAbort.signal]), new Deadline(timeoutMs));
    const timeout = new AttemptTimeout(budget, timeoutMs);
    const retryMessages: string[] = [];
    const hook: RunningSuiteHook = {
      name: running.name,
      budget,
      assertionTimeout: config.assertionTimeout,
      toPass: config.toPass,
      recordSecondaryError: (error) => { retryMessages.push(error.message); },
      ...(running.settable ? { setTimeout: (update) => (timeout.set(update(timeout.timeoutMs)) ? 'set' : 'ended') } : {}),
    };
    const leave = host.workerFixtures.enter(builtIns);
    const owns = (owner: string): void => {
      if (attempt !== undefined) attempt.steps.owner = owner;
    };
    owns(`the ${label}`);
    let failure: { readonly cause: unknown } | undefined;
    try {
      await inSuiteHook(hook, () => runHook(label, () => body(builtIns, owns), timeout, () => hookAbort.abort()));
    } catch (cause) {
      if (cause instanceof TestTimeoutError && hookAbort.signal.aborted) {
        // Let cancelled retries record their last failures before reporting the hook error.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (retryMessages.length > 0) cause.message += `\n${retryMessages.join('\n')}`;
      }
      failure = { cause };
    }
    // A step the code started and did not await is failed at its call and
    // cancelled, as after a test body: left alone it would fail once this
    // attempt closed, as a stray rejection charged to whichever test ran then.
    const notAwaited = attempt?.steps.abandonRunning();
    if (attempt !== undefined && notAwaited !== undefined) {
      hookAbort.abort();
      await withTimeout(attempt.steps.settleAbandoned(), config.cleanupTimeout, () => new Error('abandoned steps did not settle')).catch(() => undefined);
    }
    leave();
    if (failure !== undefined) throw failure.cause;
    if (notAwaited !== undefined) throw notAwaited;
  }

  /** Ends the attempt the pass opened, if it opened one; never rejects for a hook's sake. */
  async close(): Promise<void> {
    const attempt = await this.opened;
    if (attempt !== undefined && isOpen(attempt)) await attempt.close();
  }

  /** The attempt the code runs in, opened at the first call that needs one, or why it has none. */
  private async acquire(usesEngine: boolean): Promise<OpenAttempt | NoAttempt> {
    const { host, config, runErrors } = this.context;
    if (host.target.engine?.isolation !== 'worker') return 'isolated';
    if (!usesEngine) return 'unnamed';
    if (this.opened === undefined && host.interruptSignal.aborted) return 'interrupted';
    this.opened ??= this.open().catch((cause: unknown) => {
      const failure = classifyError(cause);
      runErrors.push({ error: serializeError(failure, { phase: 'launch', projectRoot: config.projectRoot }) });
      return { failure };
    });
    return this.opened;
  }

  private async open(): Promise<OpenAttempt> {
    const { host, config, models, runErrors } = this.context;
    const { shared } = this;
    const attemptId = uuidv7();
    const attemptEnd = new AbortController();
    let session: TargetSession | undefined = shared;
    const artifacts = createAttemptArtifacts({
      artifactsRoot: host.artifactsRoot,
      segments: [SUITE_HOOKS_DIR, attemptId],
      attemptId,
      ledger: () => (session === undefined ? undefined : sessionLedger(session, config.allSecrets)),
      identity: { runId: host.runId, testId: SUITE_HOOKS_DIR, attemptId },
    });
    const removeDir = async (): Promise<void> => {
      await artifacts.settle();
      // Nothing a report links lands here, so an empty directory goes.
      await rmdir(artifacts.dir).catch(() => undefined);
      await rmdir(path.dirname(artifacts.dir)).catch(() => undefined);
    };
    try {
      session ??= await host.launchSession({ session: undefined, recordings: { trace: undefined, video: undefined } }, attemptId, artifacts.dir, host.interruptSignal);
    } catch (cause) {
      await removeDir();
      throw cause;
    }
    const launched = session;
    const redact = (text: string): string => redactForSession(launched, config.allSecrets, text);
    const steps = new StepRecorder(attemptId, { maxEventsPerStep: config.limits.maxEventsPerStep, projectRoot: config.projectRoot, redact, retainSteps: 0 });
    const budget = new AttemptBudget(host.interruptSignal, new Deadline(config.timeout));
    const { fixtures } = createFixtures({
      config,
      target: host.target,
      session: launched,
      steps,
      budget,
      runId: host.runId,
      attemptId,
      attempt: { testId: SUITE_HOOKS_DIR, attemptId, titlePath: [], index: 0, signal: attemptEnd.signal, memory: new Map<string, unknown>() },
      artifacts: artifacts.sink,
      priorSteps: () => [],
      agentContext: undefined,
      saveSession: undefined,
      debug: host.debug,
      models,
    });
    return {
      builtIns: attemptBuiltIns(fixtures),
      budget,
      steps,
      close: async () => {
        attemptEnd.abort();
        budget.end();
        if (shared === undefined) {
          const errors: SerializedError[] = [];
          await host.closeSession(launched, { attemptId, video: undefined }, { status: 'passed', cleanup: 'complete' }, artifacts.sink, errors);
          for (const error of errors) runErrors.push({ error });
        }
        await removeDir();
      },
    };
  }
}

/**
 * Tears the worker fixtures down, last set up first, each within its own
 * cleanup budget. On an engine whose state outlives an attempt a teardown
 * that reaches the engine runs in a short attempt, so a worker fixture that
 * holds `device` can still drive it. A failed teardown is a run error.
 */
export async function tearDownWorkerFixtures(context: SuiteAttemptContext): Promise<void> {
  const { host, config, runErrors } = context;
  const teardowns = host.workerFixtures.close();
  if (teardowns.length === 0) return;
  const attempt = new SuiteAttempt(context, undefined);
  for (const teardown of teardowns) {
    try {
      const label = `fixture "${teardown.name}" teardown`;
      await attempt.within(label, config.cleanupTimeout, teardown.usesEngine, { name: `a worker ${label}`, settable: false }, () => teardown.run());
    } catch (cause) {
      runErrors.push({ error: serializeError(classifyError(cause), { phase: 'cleanup', projectRoot: config.projectRoot }) });
    }
  }
  await attempt.close();
}
