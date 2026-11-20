/**
 * Holding steps for `e2e run --step` and tests at `screen.pause()`. A worker
 * holds a top-level step before it runs, or a test at a pause, and asks the
 * runner, which owns the terminal, whether it may; the runner asks its `hold`
 * hook. While any step of an attempt is held, the attempt's test clock is
 * stopped, so the time a person spends looking at the app is never charged
 * to the test.
 */

import { abortError, cancelledError } from '@e2e-dev/core/lib/internal/time';
import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import type { AttemptTimeout } from '@e2e-dev/core/lib/run/budget';
import type { StepHoldRequest } from '@e2e-dev/core/lib/run/steps';
import type { OperationContext, TargetSession } from '@e2e-dev/core/lib/engine/surface';
import type { HeldTestAttachment } from './step-attachment-wire.ts';
import { traceScreen, type TraceScreenOptions } from '@e2e-dev/core/lib/run/step-screens';

/** A step held before it runs, or a paused test, as the runner's `hold` hook sees it. */
export interface HeldStep extends StepHold {
  /** The ID shown at every hold of this attempt. */
  readonly attachId: string;
}

/** A held step or pause without the runner-assigned attachment ID. */
export interface StepHold {
  /** Whether this wait is for a held step or a paused test. */
  readonly kind: StepHoldRequest['kind'];
  readonly target: string;
  readonly testId: string;
  readonly agent: string;
  readonly repeat: number;
  /** The test's title path, joined with ` › `. */
  readonly title: string;
  readonly api: string;
  /** Already redacted. */
  readonly label: string;
  readonly source?: SourceLocation;
}

/** A held step with its place among its test's held steps, from 1. Pauses use 0 because they aren't steps. */
export interface NumberedStep {
  readonly step: HeldStep;
  readonly number: number;
}

/** The held steps one key lets run, as the prompt shows them. */
export interface StepPrompt {
  /** One step, or every step held together, as in one `Promise.all`. */
  readonly steps: readonly [NumberedStep, ...NumberedStep[]];
  /** List every key, not only the short line; `h` turns it on and off. */
  readonly help: boolean;
  /**
   * Whether the run holds steps (`e2e run --step`). `n`, `a`, and `rest`
   * release them.
   */
  readonly holdSteps: boolean;
}

/** What the runner hands its `hold` hook beside the step. */
export interface StepHoldContext {
  /** Aborts once the answer no longer matters: the step was abandoned, its attempt ended, or the run was interrupted. */
  readonly signal: AbortSignal;
  /** Attaches to a held test by its pause ID. */
  attach(id: string, signal?: AbortSignal, sessionId?: string): Promise<HeldTestAttachment>;
  /**
   * Shows the step waiting for a key, or no prompt: under its test in the
   * list reporter's live window, else on stderr.
   */
  show(prompt: StepPrompt | undefined): void;
  /**
   * Reads the screen at the held step or pause. The result starts with the
   * location when available, then lists one line per node. The lines are
   * redacted and bounded like those on the trace page. Steps held together
   * share one read.
   *
   * It returns `undefined` if the screen can't be read, or if it's called
   * after the wait has ended. A read that is still running when the wait
   * ends can return the screen, so check that the step or pause is still
   * held before using the result.
   */
  readScreen(): Promise<string | undefined>;
}

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
  /** Asks the runner whether the step may run. The runner can call `readScreen` to read the screen during the wait. */
  readonly ask: (step: StepHold, signal: AbortSignal, readScreen: StepHoldContext['readScreen']) => Promise<void>;
  /** Reads the screen a hold starts on. */
  readonly readScreen: (signal: AbortSignal) => Promise<string | undefined>;
}

/** The holds of one test attempt: each hold asks the runner, which can read the screen the hold starts on. */
export function holdAttemptSteps(options: AttemptStepHolds): AttemptHolds {
  const { attempt, ask, readScreen } = options;
  // Steps held together (one `Promise.all`) wait on one screen, read once.
  let heldScreen: Promise<string | undefined> | undefined;
  return new AttemptHolds({
    timeout: options.timeout,
    signal: options.signal,
    ask: async (step, signal) => {
      await ask(
        { kind: step.kind, ...attempt, api: step.api, label: step.label, ...(step.source === undefined ? {} : { source: step.source }) },
        signal,
        () => (heldScreen ??= readScreen(signal)),
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
