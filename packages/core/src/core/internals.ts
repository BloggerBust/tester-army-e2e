/**
 * What `@e2e-dev/core/agent` reads off a session it did not create: the attempt
 * behind it, the host's config, and the session's close hooks. Module-private
 * state behind a WeakMap, so a session object carries none of it.
 */

import { MODEL_UNREACHABLE_CODES } from '../agent/error.ts';
import type { AttemptSettlement, SurvivedFailure } from '../cache/context.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { currentAttempt } from '../expect/attempt.ts';
import { currentPollScope, outlivesTest } from '../expect/poll-scope.ts';
import { TestError } from '../internal/errors.ts';
import type { AttemptGuests, GuestSession, GuestSteps } from '../run/guest-steps.ts';
import type { SessionVideo } from '../run/records.ts';
import type { StandaloneAttempt } from '../run/standalone-attempt.ts';
import type { StepProgress, StepRecord, StepRecorder } from '../run/steps.ts';

export interface SessionInternals {
  readonly attempt: StandaloneAttempt;
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  /** Run in order when the session closes, before its attempt ends: an agent settles its replay cache here. */
  readonly closers: (() => Promise<void>)[];
  /** How the session's steps went, as the replay cache settles what its agents recorded; undefined once it was cancelled. */
  readonly settlement: () => AttemptSettlement | undefined;
}

/**
 * Watches a session's steps for the agent steps that failed. A test ends at
 * its failure; a program may catch one and go on. So each failure settles
 * only the recordings it found unconfirmed, as a run's failure does: dropped,
 * unless only a missing model explains it. Recordings made after it are
 * confirmed by the checks that pass after them.
 */
export class FailureWatch {
  private steps: StepRecorder | undefined;
  private readonly failures: SurvivedFailure[] = [];

  /** The `onProgress` hook the session's attempt reports its steps to. */
  readonly onProgress = (progress: StepProgress): void => {
    // Only an agent step's failure implicates recordings: a program catches a locator's timeout on purpose, to branch.
    if (progress.phase !== 'end' || progress.kind !== 'agent' || progress.status === 'passed' || this.steps === undefined) return;
    const code = progress.error?.code;
    this.failures.push({
      from: this.steps.lastVerifiedStepIndex,
      through: progress.identity?.stepIndex ?? Number.MAX_SAFE_INTEGER,
      implicates: code === undefined || !MODEL_UNREACHABLE_CODES.has(code),
    });
  };

  watch(steps: StepRecorder): void {
    this.steps = steps;
  }

  /**
   * How the session's recordings settle when it closes. A close is not a
   * verdict: a program may end, or be interrupted, between a replay and the
   * check after it, so what no check confirmed is left as it was, neither
   * written nor evicted.
   */
  settlement(steps: StepRecorder): AttemptSettlement {
    return { lastVerifiedStepIndex: steps.lastVerifiedStepIndex, implicatesUnconfirmed: false, survived: this.failures };
  }
}

/**
 * What the test running now offers the caller, when the caller is part of
 * it. A body past its timeout goes on running while the next test does, and
 * a worker fixture is set up inside the first test that names it and lives
 * on after it: what either opens or steps is no test's to end, so it is
 * offered nothing.
 */
export function currentGuests(): AttemptGuests | undefined {
  return currentPollScope()?.over === true || outlivesTest() ? undefined : currentAttempt()?.guests;
}

/**
 * A session's part in the tests around it (`run/guest-steps.ts`): it tells a
 * test of each step it takes, so the test's report covers them. Which test
 * is decided once, when the session starts opening; see `sessionGuest`.
 */
export interface SessionGuest {
  /** Whether the session records a video for the test it is part of. */
  readonly recordsVideo: boolean;
  /** Aborts when the test the session is opening for gives it up; absent for a session no test owns. */
  readonly signal: AbortSignal | undefined;
  /** Takes the error the opening failed with: told already when the test gave the session up, else the caller's to meet, and the test's seat is given back. */
  failed(error: unknown): void;
  /** Takes each progress of the session's recorder with its record of the step. */
  readonly mirror: (progress: StepProgress, record: StepRecord) => void;
  /** Hands over the open session. False when the test it was opening for gave it up: it is the caller's to close. */
  attach(session: GuestSession): boolean;
  /** Hands on the videos the session recorded. */
  videos(recordings: readonly SessionVideo[]): Promise<void>;
}

/**
 * The guest of a session being opened now. Opened by a running test, it is
 * that test's for good: named now, recorded on video if the test keeps
 * videos, and closed with the test. Opened outside every test, on a host
 * from a hook or the top of a file, it visits whichever test is running
 * when it starts a step, and a step outside every test is told to nobody.
 */
export function sessionGuest(): SessionGuest {
  const opener = currentGuests();
  return opener === undefined ? visitingGuest() : ownedGuest(opener);
}

function ownedGuest(opener: AttemptGuests): SessionGuest {
  const seat = opener.session();
  let steps: GuestSteps | undefined;
  return {
    recordsVideo: opener.video,
    signal: seat.signal,
    failed: (error) => {
      if (seat.signal.aborted) opener.gaveUp(error);
      // The caller meets this rejection, so nothing of the opening is left running in the test.
      else seat.release?.();
    },
    mirror: (progress, record) => steps?.progress(progress, record),
    attach: (session) => {
      steps = seat.take(session);
      return steps !== undefined;
    },
    videos: async (recordings) => {
      for (const recording of recordings) await steps?.video(recording);
    },
  };
}

function visitingGuest(): SessionGuest {
  let session: GuestSession | undefined;
  /** The test the session last started a step in, and where that test takes its steps. */
  let visited: { readonly guests: AttemptGuests | undefined; readonly steps: GuestSteps | undefined } = { guests: undefined, steps: undefined };
  return {
    recordsVideo: false,
    signal: undefined,
    failed: () => undefined,
    mirror: (progress, record) => {
      if (progress.phase === 'start') {
        const guests = currentGuests();
        if (guests !== visited.guests) visited = { guests, steps: session === undefined ? undefined : guests?.visit(session) };
      }
      visited.steps?.progress(progress, record);
    },
    attach: (opened) => {
      session = opened;
      return true;
    },
    videos: () => Promise.resolve(),
  };
}

const sessions = new WeakMap<object, SessionInternals>();

/** Records the internals of a session `launch` created. */
export function registerSession(session: object, internals: SessionInternals): void {
  sessions.set(session, internals);
}

/** The internals of a session `launch` created; anything else is `INVALID_ARGUMENT`. */
export function sessionInternals(session: unknown, api: string): SessionInternals {
  const internals = typeof session === 'object' && session !== null ? sessions.get(session) : undefined;
  if (internals === undefined) throw new TestError('INVALID_ARGUMENT', `${api} takes a session from host.newSession()`);
  return internals;
}
