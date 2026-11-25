/**
 * Target worker core: the single implementation of "execute work units for one
 * target and stream records back". Both transports (child process and
 * in-process) drive this class, so unit execution, interrupt handling, and
 * run-error forwarding exist exactly once.
 */

import inspector from 'node:inspector';
import type { ModuleRegistration } from '../../collect/registry.ts';
import type { TestTargetPair } from '../../collect/select.ts';
import type { ResolvedConfig, ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { DebugTrace } from '@e2e-dev/core/lib/internal/debug';
import { ConfigurationError, E2EError, type SerializedError } from '@e2e-dev/core/lib/internal/errors';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { abortError, cancelledError } from '@e2e-dev/core/lib/internal/time';
import { TargetExecutor, type InMemoryAttempts } from '../execute.ts';
import { encodeResult, type RunError } from '@e2e-dev/core/lib/run/records';
import type { SessionStore } from '@e2e-dev/core/lib/run/sessions';
import type { HoldReads, StepHold } from '../step-hold.ts';
import type { HeldTestTools } from './held-test-tools.ts';
import { countsTowardFailureLimit, disappearedResult } from '../units.ts';
import type { MainToWorker, RunUnitMessage, WirePair, WorkerToMain } from './protocol.ts';

/** Pairs resolved locally for one unit, plus identities that vanished. */
export interface ResolvedUnitPairs {
  readonly pairs: readonly TestTargetPair[];
  /** Planned pairs whose test is absent from this worker's view of the file. */
  readonly missing: readonly WirePair[];
  /**
   * The module registration the pairs were resolved against, when there is
   * one: `reusable`, or the resolver's own import, in which nothing has run.
   * The executor adopts it as the unit's first realm instead of importing the
   * file again.
   */
  readonly registration?: ModuleRegistration;
}

/**
 * Turns a unit's wire pairs into executable pairs. A child-process worker
 * imports the file, unless an earlier unit of the file left `reusable`; an
 * in-process worker looks the pairs up in the selection the runner already
 * collected.
 */
export type ResolveUnitPairs = (unit: RunUnitMessage, reusable: ModuleRegistration | undefined) => Promise<ResolvedUnitPairs>;

export interface TargetWorkerDeps {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly sessionStore: SessionStore;
  readonly runId: string;
  readonly artifactsRoot: string;
  /** See `TargetExecutorOptions.rerunDir`. */
  readonly rerunDir: string | undefined;
  readonly headed: boolean;
  /** See `TargetExecutorOptions.workerSlot`. */
  readonly workerSlot: number;
  /** See `TargetExecutorOptions.env`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether the worker has a process of its own; see `TargetExecutorOptions.isolated`. */
  readonly isolated: boolean;
  readonly resolvePairs: ResolveUnitPairs;
  readonly debug?: DebugTrace;
  /** See `TargetExecutorOptions.inMemory`; only an in-process worker has tests registered in memory. */
  readonly inMemory?: InMemoryAttempts | undefined;
  /** Whether steps wait for the runner's `step-release` (`e2e run --step`). Pauses always wait. */
  readonly holdSteps: boolean;
}

/** Transport callbacks a target worker needs. */
export interface TargetWorkerHost {
  emit(message: WorkerToMain): void;
  /** Unrecoverable failure: the worker must be treated as dead afterwards. */
  fatal(cause: unknown): void;
  /** Graceful end of life, after engine disposal. */
  finished(): void;
}

type WorkerHold = HoldReads & {
  readonly release: (error: SerializedError | undefined) => void;
  readonly tools: HeldTestTools;
};

export class TargetWorker {
  private readonly interruptController = new AbortController();
  private readonly reuseController = new AbortController();
  private deps: TargetWorkerDeps | undefined;
  private executor: TargetExecutor | undefined;
  private runErrorWatermark = 0;
  /**
   * The pair executing now, for attributing output the process writes: set
   * when a pair starts, cleared at its result and when its unit is done. A
   * serial group's members follow one another, so the latest start is the
   * one running.
   */
  private inFlight: { readonly testId: string; readonly agent: string; readonly repeat: number } | undefined;

  /** The pair executing now, or undefined between units. */
  get pairInFlight(): { readonly testId: string; readonly agent: string; readonly repeat: number } | undefined {
    return this.inFlight;
  }
  /** Whether the run has a failure limit, so each failure this worker reports waits for the runner's answer. */
  private answersFailures = false;
  /** Failures this worker reported that the runner has not answered yet. */
  private unanswered = 0;
  /** Wakes the wait in `failuresAnswered` once the last of them is answered. */
  private answered: (() => void) | undefined;
  /** Serializes message handling so units never overlap on one worker. */
  private queue: Promise<void> = Promise.resolve();
  /** Disposal happens once, whichever of shutdown or terminate asks first. */
  private shutdownOnce: Promise<void> | undefined;
  /** Steps and pauses waiting for `step-release`, by hold ID. */
  private readonly holds = new Map<string, WorkerHold>();

  /** Gets any pending hold for a request that names the attachment rather than the hold. */
  private get firstHold(): WorkerHold | undefined {
    // A worker runs one attempt at a time, so all its holds share that attempt's tools.
    return this.holds.values().next().value;
  }

  constructor(
    private readonly host: TargetWorkerHost,
    private readonly bootstrap: () => Promise<TargetWorkerDeps>,
  ) {}

  /** Boots the worker and announces readiness. Enqueued like any other work. */
  start(): void {
    this.enqueue(async () => {
      const deps = await this.bootstrap();
      this.deps = deps;
      this.executor = new TargetExecutor({
        config: deps.config,
        target: deps.target,
        runId: deps.runId,
        artifactsRoot: deps.artifactsRoot,
        rerunDir: deps.rerunDir,
        sessionStore: deps.sessionStore,
        headed: deps.headed,
        workerSlot: deps.workerSlot,
        env: deps.env,
        isolated: deps.isolated,
        interruptSignal: this.interruptController.signal,
        hold: {
          ask: (step, signal, reads, tools) => this.holdStep(step, signal, reads, tools),
          steps: deps.holdSteps,
        },
        ...(deps.debug !== undefined ? { debug: deps.debug } : {}),
        inMemory: deps.inMemory,
        beforePair: () => this.failuresAnswered(),
        events: {
          onResult: (result) => {
            // Teardown after the result (an afterAll) belongs to no pair.
            if (this.inFlight?.testId === result.test.id && this.inFlight.agent === result.agent && this.inFlight.repeat === result.repeat) {
              this.inFlight = undefined;
            }
            // Counted before it is sent: an in-process runner answers inside `emit`.
            if (this.answersFailures && countsTowardFailureLimit(result.status)) this.unanswered += 1;
            this.host.emit({ type: 'result', result: encodeResult(result) });
          },
          onSerialGroup: (group) => this.host.emit({ type: 'serial-group', group }),
          onAttemptStart: (pair, index) =>
            this.host.emit({ type: 'attempt-start', testId: pair.test.id, agent: pair.agent, repeat: pair.repeat, index }),
          onAttempt: (pair, attempt) =>
            this.host.emit({ type: 'attempt', testId: pair.test.id, agent: pair.agent, repeat: pair.repeat, attempt }),
          onSerialMember: (groupId, attempt, member) => this.host.emit({ type: 'serial-member', groupId, attempt, member }),
          onSerialAttempt: (groupId, attempt) => this.host.emit({ type: 'serial-attempt', groupId, attempt }),
          onPairStart: (pair) => {
            this.inFlight = { testId: pair.test.id, agent: pair.agent, repeat: pair.repeat };
            this.host.emit({
              type: 'pair-start',
              testId: pair.test.id,
              agent: pair.agent,
              repeat: pair.repeat,
              title: pair.test.titlePath.join(' > '),
              file: pair.test.file,
              serialId: pair.test.serialId,
            });
          },
          onAttemptDeadline: (pair, attempt) => {
            // A worker paused at a breakpoint looks blocked; with a debugger attached nothing watches its attempts.
            if (inspector.url() !== undefined) return;
            this.host.emit({
              type: 'attempt-deadline',
              testId: pair.test.id,
              agent: pair.agent,
              repeat: pair.repeat,
              attempt: attempt.index,
              attemptId: attempt.id,
              startedAt: attempt.startedAt,
              timeoutMs: attempt.timeoutMs,
              ...(attempt.remainingMs === undefined ? {} : { remainingMs: attempt.remainingMs }),
              graceMs: deps.config.cleanupTimeout,
            });
          },
          onAttemptEnd: () => this.host.emit({ type: 'attempt-end' }),
          onProgress: (pair, progress) =>
            this.host.emit({ type: 'progress', testId: pair.test.id, agent: pair.agent, repeat: pair.repeat, progress }),
          onNotice: (message) => this.host.emit({ type: 'notice', message }),
          onRunAbort: (runError) => {
            this.interruptController.abort();
            this.host.emit({ type: 'run-abort', error: runError.error });
          },
        },
      });
      this.host.emit({ type: 'ready' });
    });
  }

  /**
   * Hands a rejection nobody in this process caught to the executor, which
   * charges it to the attempt in flight or records it against the last test
   * that finished. False when there is neither, and the rejection is the
   * worker's to die of.
   */
  strayRejection(cause: unknown): boolean {
    return this.executor?.strayRejection(cause) ?? false;
  }

  handle(message: MainToWorker): void {
    switch (message.type) {
      case 'interrupt':
        // The skip rides as the abort reason, so the executor's unstarted pairs can say why.
        this.interruptController.abort(message.skip);
        return;
      case 'run-unit':
        this.enqueue(() => this.runUnit(message));
        return;
      case 'shutdown':
        if (message.preserveResources !== true) this.reuseController.abort();
        this.enqueue(() => this.shutdown());
        return;
      case 'terminate':
        this.terminate();
        return;
      case 'ping':
        // Answered now, not queued behind the running unit: the answer is the proof the event loop turns.
        this.host.emit({ type: 'pong' });
        return;
      case 'step-release':
        // Now too: the unit it releases is the one running.
        this.holds.get(message.holdId)?.release(message.error);
        return;
      case 'continue':
        // Now too: the running unit is what waits for it.
        this.unanswered -= 1;
        if (this.unanswered === 0) this.answered?.();
        return;
      case 'step-attachment-request': {
        const { requestId, request } = message;

        const hold = request.kind === 'attach' ? this.holds.get(request.holdId) : this.firstHold;

        if (hold === undefined) {
          this.host.emit({
            type: 'step-attachment-reply',
            requestId,
            response: request.kind === 'detach'
              ? { kind: 'detach' }
              : {
                  kind: 'error',
                  error: {
                    category: 'configuration',
                    code: 'NO_SESSION',
                    message: 'the test resumed',
                  },
                },
          });
        } else {
          void hold.tools.request(requestId, request).then((response) => {
            this.host.emit({ type: 'step-attachment-reply', requestId, response });
          });
        }
        return;
      }
      case 'step-attachment-cancel':
        this.firstHold?.tools.cancel(message.requestId);
        return;
      case 'screen-request':
      case 'logs-request': {
        // Handle this right away because the waiting unit is still running.
        const { requestId, holdId } = message;
        const hold = this.holds.get(holdId);

        if (message.type === 'screen-request') {
          void Promise.resolve(hold?.readScreen()).then((screen) => {
            this.host.emit({ type: 'screen-reply', requestId, ...(screen === undefined ? {} : { screen }) });
          });
        } else {
          void Promise.resolve(hold?.readLogs()).then((logs) => {
            this.host.emit({ type: 'logs-reply', requestId, ...(logs === undefined ? {} : { logs }) });
          });
        }
        return;
      }
      default:
        message satisfies never;
    }
  }

  /**
   * Holds one step or pause until the runner releases it, and rejects with
   * the release's error if it has one. A hold that ends first (the step was
   * abandoned, its attempt ended) tells the runner, so its prompt goes away,
   * and rejects with the signal's reason. During the hold, the screen is
   * available through `readScreen` and the app log through `readLogs`.
   */
  private holdStep(
    step: StepHold,
    signal: AbortSignal,
    reads: HoldReads,
    tools: HeldTestTools,
  ): Promise<void> {
    const holdId = uuidv7();
    return new Promise<void>((resolve, reject) => {
      // The wait was abandoned before it started. Don't send it to the runner.
      if (signal.aborted) {
        reject(abortError(signal, cancelledError));
        return;
      }

      const settle = (reason: Error): void => {
        this.holds.delete(holdId);
        signal.removeEventListener('abort', cancel);
        tools.end(reason);
      };

      const cancel = (): void => {
        const reason = this.interruptController.signal.aborted ? 'the run was interrupted' : 'the test hold ended';
        settle(abortError(signal, () => new ConfigurationError('NO_SESSION', reason)));
        this.host.emit({ type: 'step-cancel', holdId });
        reject(abortError(signal, cancelledError));
      };

      this.holds.set(holdId, {
        release: (error) => {
          settle(new ConfigurationError('NO_SESSION', error === undefined ? 'the test resumed' : 'the test hold failed'));

          if (error === undefined) {
            resolve();
          } else {
            reject(new E2EError(error.category, error.code, error.message));
          }
        },
        ...reads,
        tools,
      });
      signal.addEventListener('abort', cancel, { once: true });

      this.host.emit({
        type: 'step-hold',
        holdId,
        attemptId: tools.attemptId,
        step,
        attachmentLabels: tools.attachmentLabels,
      });
    });
  }

  /**
   * Resolves once the runner has answered every failure this worker reported,
   * or the interrupt arrived. The runner alone counts failures toward the
   * run's limit, so a worker whose failure reached it never starts another
   * test: the interrupt answering that failure skips the rest with the
   * limit's reason.
   */
  private failuresAnswered(): Promise<void> {
    const signal = this.interruptController.signal;
    if (this.unanswered === 0 || signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = (): void => {
        this.answered = undefined;
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.answered = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * A forced interrupt. Disposal runs beside the running unit instead of
   * queued behind it: the unit is exactly what a second interrupt refuses to
   * wait for. Its later engine calls fail against a disposed engine, which
   * no longer matters — nothing it reports from here on is kept.
   */
  private terminate(): void {
    this.reuseController.abort();
    this.interruptController.abort();
    this.shutdown().catch((cause: unknown) => {
      this.host.fatal(cause);
    });
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((cause: unknown) => {
      this.host.fatal(cause);
    });
  }

  private async runUnit(message: RunUnitMessage): Promise<void> {
    const deps = this.deps;
    const executor = this.executor;
    if (deps === undefined || executor === undefined) {
      throw new Error('received a work unit before the worker finished starting');
    }
    // `unit-done` is sent only when the unit ran to completion. A throw here
    // (a module that fails to re-import, a realm that cannot be created) is
    // fatal for the worker; the scheduler still holds the unit and synthesizes
    // failed results for every pair it never heard about. Reporting the unit
    // done first would clear that bookkeeping and drop those tests silently.
    this.answersFailures = message.answersFailures === true;
    // A setup test owns its realm, so only a file unit runs in an instance an earlier one left.
    const reusable = message.kind === 'file' ? executor.realms.takeReusable(message.file) : undefined;
    const { pairs, missing, registration } = await deps.resolvePairs(message, reusable);
    for (const wire of missing) {
      executor.recordDisappeared(
        `test ${wire.test.id} disappeared before execution; registration must be deterministic`,
      );
      executor.emit(disappearedResult(wire, deps.target));
    }
    if (message.kind === 'setup') {
      // The imported registration has run nothing yet, so only the first
      // setup pair may adopt it; any later one needs its own fresh realm.
      for (const [index, pair] of pairs.entries()) {
        await executor.runSetupUnit(pair, index === 0 ? registration : undefined);
      }
    } else {
      await executor.runFileUnit(
        { file: message.file, absolutePath: message.absolutePath },
        pairs,
        registration,
        message.split === true,
      );
    }
    this.inFlight = undefined;
    this.host.emit({
      type: 'unit-done',
      unitId: message.unitId,
      runErrors: this.drainRunErrors(executor),
    });
  }

  /** Run errors accumulate on the executor; forward only the new ones. */
  private drainRunErrors(executor: TargetExecutor): readonly RunError[] {
    const runErrors = executor.collectedRunErrors();
    const delta = runErrors.slice(this.runErrorWatermark);
    this.runErrorWatermark = runErrors.length;
    return delta;
  }

  private shutdown(): Promise<void> {
    this.shutdownOnce ??= this.disposeAndFinish();
    return this.shutdownOnce;
  }

  private async disposeAndFinish(): Promise<void> {
    // The engine belongs to this worker's executor on both transports. Its
    // disposal records run errors after the last unit drained, so they ship
    // on a final message of their own; dispose itself never throws.
    const executor = this.executor;
    if (executor !== undefined) {
      await executor.dispose(this.reuseController.signal.aborted ? {} : { reuseSignal: this.reuseController.signal });
    }
    this.host.emit({
      type: 'shutdown-done',
      runErrors: executor === undefined ? [] : this.drainRunErrors(executor),
    });
    this.host.finished();
  }
}
