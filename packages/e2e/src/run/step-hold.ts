/**
 * Holding steps for `e2e run --step` and tests at `screen.pause()`. A worker
 * holds a top-level step before it runs, or a test at a pause, and asks the
 * runner, which owns the terminal, whether it may; the runner asks its `hold`
 * hook. While any step of an attempt is held, the attempt's test clock is
 * stopped, so the time a person spends looking at the app is never charged
 * to the test.
 */

import { abortError, cancelledError } from '@e2e-dev/core/lib/internal/time';
import type { AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import type { StepHoldRequest } from '@e2e-dev/core/lib/run/steps';
import type { OperationContext, TargetSession } from '@e2e-dev/core/lib/engine/surface';
import type { HeldTestAttachment } from './step-attachment-wire.ts';
import { traceScreen, type TraceScreenOptions } from '@e2e-dev/core/lib/run/step-screens';
import type { PausedKey, PausedStep, RunEventOf } from './events.ts';

/** A step held before it runs, or a paused test, as the runner's `hold` hook sees it. */
export interface HeldStep extends Omit<StepHold, 'number'> {
  /** The ID shown at every hold of this attempt. */
  readonly attachId: string;
}

/** A held step or pause without the runner-assigned attachment ID. */
export interface StepHold extends StepHoldRequest {
  readonly target: string;
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  /** The test's title path, joined with ` › `. */
  readonly title: string;
}

/** A held step with its expected position in the trace. Pauses use 0. */
export interface NumberedStep {
  readonly step: HeldStep;
  readonly number: number;
}

/** The held steps one key lets run, as the prompt shows them. */
export interface StepPrompt {
  /** One step, or every step held together, as in one `Promise.all`. */
  readonly steps: readonly [NumberedStep, ...NumberedStep[]];
  /**
   * Whether the run holds steps (`e2e run --step`). `n`, `a`, and `rest`
   * release them.
   */
  readonly holdSteps: boolean;
  /** What the keyboard does now, in the order to list it. Empty when no keyboard answers the prompt: `e2e run --step` commands do. */
  readonly keys: readonly PausedKey[];
}

/** The `paused` event of `prompt`: its test, the calls that wait, and the keys a keyboard takes. */
function pausedFact(prompt: StepPrompt, titlePath: readonly string[] | undefined): RunEventOf<'paused'> {
  const waits = ({ step, number }: NumberedStep): PausedStep => ({
    number,
    api: step.api,
    label: step.label,
    ...(step.source === undefined ? {} : { source: step.source }),
  });
  const [first, ...rest] = prompt.steps;
  const { step } = first;
  return {
    type: 'paused',
    testId: step.testId,
    agent: step.agent,
    repeat: step.repeat,
    target: step.target,
    // A test the run did not collect, as one a host runs by itself, is known by the title its hold names.
    titlePath: titlePath ?? [step.title],
    reason: step.kind === 'pause' ? 'pause' : 'step',
    attachId: step.attachId,
    steps: [waits(first), ...rest.map(waits)],
    keys: [...prompt.keys],
  };
}

/** One run of one test on one target, as the events name it. */
type TestRun = Pick<RunEventOf<'paused'>, 'testId' | 'agent' | 'repeat' | 'target'>;

/** The `paused` and `resumed` events of one run. */
interface PauseEvents {
  /** The `hold` hook shows `prompt`, or takes its prompt down. */
  show(prompt: StepPrompt | undefined): void;
  /** A test's result is in: a wait of its own is over. */
  testEnded(test: TestRun): void;
  /** The run is over: an open wait ends, and nothing shown later is told. */
  end(): void;
}

/**
 * Tells a run's reporters which test waits for a person. The `hold` hook
 * says when a wait begins and ends; one still open when its test or the
 * run ends is ended here, so every `paused` gets its `resumed`, before the
 * next test's `paused` and before `run-finished`. `titlePathOf` answers a
 * collected test's title path by its id.
 */
export function pauseEvents(
  emit: (fact: RunEventOf<'paused'> | RunEventOf<'resumed'>) => void,
  titlePathOf: (testId: string) => readonly string[] | undefined,
): PauseEvents {
  let paused: RunEventOf<'paused'> | undefined;
  let ended = false;
  const same = (test: TestRun): boolean =>
    paused !== undefined && paused.testId === test.testId && paused.agent === test.agent && paused.repeat === test.repeat && paused.target === test.target;
  const resume = (): void => {
    if (paused === undefined) return;
    const { testId, agent, repeat, target } = paused;
    paused = undefined;
    emit({ type: 'resumed', testId, agent, repeat, target });
  };
  return {
    show(prompt) {
      if (ended) return;
      const next = prompt === undefined ? undefined : pausedFact(prompt, titlePathOf(prompt.steps[0].step.testId));
      if (next === undefined || !same(next)) resume();
      if (next === undefined) return;
      paused = next;
      emit(next);
    },
    testEnded(test) {
      if (same(test)) resume();
    },
    end() {
      resume();
      ended = true;
    },
  };
}

/** What the runner hands its `hold` hook beside the step. */
export interface StepHoldContext {
  /** Expected position of the held step in the trace. A pause uses 0. */
  readonly number: number;
  /** The test title and target name after redaction. */
  readonly labels: Pick<HeldStep, 'title' | 'target'>;
  /** Aborts once the answer no longer matters: the step was abandoned, its attempt ended, or the run was interrupted. */
  readonly signal: AbortSignal;
  /** Attaches to a held test by its pause ID. */
  attach(id: string, signal?: AbortSignal, sessionId?: string): Promise<HeldTestAttachment>;
  /**
   * Tells the reporters the test waits, as a `paused` event, and `resumed`
   * once passed `undefined`. Unless an interactive reporter shows it, a
   * prompt a keyboard answers is printed on stderr.
   */
  show(prompt: StepPrompt | undefined): void;
  /**
   * Reads the screen at the held step or pause. The result starts with the
   * location when available, then lists one line per node. The lines are
   * redacted and bounded like those on the trace page. Steps held together
   * share one read.
   *
   * It returns `undefined` if the screen can't be read, or if it's called
   * after the wait has ended.
   */
  readScreen(): Promise<string | undefined>;
  /** Reads the attempt's redacted app log lines, numbered as in the trace. The result is `undefined` after the wait has ended. */
  readLogs(): Promise<readonly string[] | undefined>;
}

export type HoldReads = Pick<StepHoldContext, 'readScreen' | 'readLogs'>;

/**
 * Decides when a held step runs or a paused test resumes: it resolves to run
 * the step or resume the test. To stop instead, interrupt the run; the
 * interrupt aborts `context.signal`. A rejection before a step stops the run
 * with that error, and a rejection at a pause fails the test there.
 */
export type BeforeStep = (step: HeldStep, context: StepHoldContext) => Promise<void>;

/** What an attempt's holds need from the attempt. */
export interface AttemptHoldsOptions {
  /** The test clock a hold stops; it hands the watchdog what is left when it runs again. */
  readonly timeout: AttemptTimeout;
  /** Aborts when the attempt is cut short (a timeout, an interrupt): every hold ends and none starts. */
  readonly signal: AbortSignal;
  /** Asks the runner whether `step` may run; the same contract as `BeforeStep`. */
  readonly ask: (step: StepHoldRequest, signal: AbortSignal) => Promise<void>;
  /** The last pending hold ended and the test clock runs again. */
  readonly onResume: () => void;
}

/**
 * The holds of one attempt and the test clock they stop. The clock stops
 * when the first hold begins and runs again when no hold is pending, so
 * steps held together in one `Promise.all` are charged their wait once.
 * Every release hands the phase a fresh deadline of what was left when the
 * clock stopped, so a released step starts with that budget even while a
 * step beside it is still held.
 */
export class AttemptHolds {
  private pending = 0;

  constructor(private readonly options: AttemptHoldsOptions) {}

  /** The hold a `StepRecorder` takes; see `StepRecorderOptions.hold`. */
  readonly hold = async (step: StepHoldRequest, signal: AbortSignal): Promise<void> => {
    const cancel = AbortSignal.any([signal, this.options.signal]);
    if (cancel.aborted) throw abortError(cancel, cancelledError);
    // Already past the deadline, the body times out now, not after a prompt.
    if (this.pending === 0 && !this.options.timeout.stop()) return;
    this.pending += 1;
    try {
      await this.options.ask(step, cancel);
    } finally {
      this.pending -= 1;
      if (this.pending > 0) this.options.timeout.refill();
      else {
        this.options.timeout.start();
        this.options.onResume();
      }
    }
  };
}

/** What a test attempt's holds are built from. */
export interface AttemptStepHolds extends Pick<AttemptHoldsOptions, 'timeout' | 'signal'> {
  /** The attempt as every step held in it names it. */
  readonly attempt: Pick<StepHold, 'target' | 'testId' | 'agent' | 'repeat' | 'title'>;
  /** Callback to decide whether the step may run. The screen is available while waiting. */
  readonly ask: (step: StepHold, signal: AbortSignal, readScreen: HoldReads['readScreen']) => Promise<void>;
  /** Reads the screen a hold starts on. */
  readonly readScreen: (signal: AbortSignal) => Promise<string | undefined>;
}

/** The holds of one test attempt: each hold asks the runner, which can read the screen the hold starts on. */
export function holdAttemptSteps(options: AttemptStepHolds): AttemptHolds {
  const { attempt, ask, readScreen } = options;
  // Steps held together (one `Promise.all`) share a screen read.
  let heldScreen: Promise<string | undefined> | undefined;
  return new AttemptHolds({
    timeout: options.timeout,
    signal: options.signal,
    ask: async (step, signal) => {
      await ask(
        { ...step, ...attempt },
        signal,
        () => {
          if (heldScreen === undefined) {
            const request = readScreen(signal).then((screen) => {
              if (screen === undefined && heldScreen === request) {
                heldScreen = undefined;
              }

              return screen;
            });
            heldScreen = request;
          }

          return heldScreen;
        },
      );
    },
    // The clock runs again and tells the watchdog itself; the next hold reads a fresh screen.
    onResume: () => (heldScreen = undefined),
  });
}

/**
 * The screen a held step waits on, as the trace page lists one: its
 * location, then a line per node, redacted with the session's ledger. Read
 * while the test clock is stopped; a screen that cannot be read (no app open
 * yet, an engine without a tree) is undefined and never fails the test.
 */
export async function readHeldScreen(
  session: TargetSession,
  operation: OperationContext,
  options: TraceScreenOptions,
): Promise<string | undefined> {
  try {
    const screen = traceScreen(await session.observe(operation), options);
    if (screen === undefined) return undefined;
    return [...(screen.location === undefined ? [] : [screen.location]), ...screen.lines.map((line) => line.text)].join('\n');
  } catch {
    return undefined;
  }
}
