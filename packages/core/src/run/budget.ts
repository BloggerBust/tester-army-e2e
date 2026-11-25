/** The cancellation signal and deadline an attempt's fixtures run under, per phase. */

import { Deadline } from '../internal/time.ts';
import { leftRunning, pollReadSignal } from '../expect/poll-scope.ts';

interface Phase {
  readonly signal: AbortSignal;
  readonly deadline: Deadline;
}

const ENDED: Phase = { signal: AbortSignal.abort(), deadline: new Deadline(0) };

/**
 * One attempt's fixture budget. Through `beforeEach` and the body it is the
 * attempt signal and the test deadline. Each `afterEach` hook then enters a
 * budget of its own (every teardown hook has a separate `cleanupTimeout`), so
 * teardown can still drive the app after the body timed
 * out or was cancelled, and a hook that overruns is cancelled without taking
 * the next hook's budget with it. Fixtures read the budget at call time, so a
 * fixture acquired in the body keeps working in teardown.
 *
 * Work a phase left running reads an ended budget, whichever phase runs
 * now: a body past its timeout resumes during its own teardown or the next
 * test, and may reach that test's budget through a worker fixture.
 */
export class AttemptBudget {
  private current: Phase;
  private combined: { readonly reading: AbortSignal; readonly phase: AbortSignal; readonly signal: AbortSignal } | undefined;

  constructor(signal: AbortSignal, deadline: Deadline) {
    this.current = { signal, deadline };
  }

  /** The signal the running phase's operations abort with. */
  get signal(): AbortSignal {
    const reading = pollReadSignal();
    const phase = this.phase.signal;
    if (reading === undefined) return phase;
    if (this.combined?.reading !== reading || this.combined.phase !== phase) {
      this.combined = { reading, phase, signal: AbortSignal.any([reading, phase]) };
    }
    return this.combined.signal;
  }

  /** The deadline the running phase's operations are capped by. */
  get deadline(): Deadline {
    return this.phase.deadline;
  }

  /** The running phase's deadline whoever asks: the clock `AttemptTimeout` keeps, also from a step its body left running. */
  get clock(): Deadline {
    return this.current.deadline;
  }

  private get phase(): Phase {
    return leftRunning() ? ENDED : this.current;
  }

  /**
   * Switches to a fresh budget of `timeoutMs` that also follows `parent`.
   * Aborting the returned controller cancels only this budget's operations.
   */
  enter(parent: AbortSignal, timeoutMs: number): AbortController {
    const controller = new AbortController();
    this.current = {
      signal: AbortSignal.any([parent, controller.signal]),
      deadline: new Deadline(timeoutMs),
    };
    return controller;
  }

  /**
   * Ends the running phase: every operation that reads the budget is
   * cancelled until a later phase enters. Covers what `leftRunning` cannot
   * see, a callback that lost its async context.
   */
  end(): void {
    this.current = ENDED;
  }

  /**
   * Gives the running phase a deadline `remainingMs` from now, keeping its
   * signal: the test clock running again after `e2e run --step` held a step.
   */
  resetDeadline(remainingMs: number): void {
    this.current = { signal: this.current.signal, deadline: new Deadline(remainingMs) };
  }

  /**
   * Moves the running phase's deadline by `deltaMs`, later or earlier,
   * keeping its signal: `test.setTimeout` through `AttemptTimeout.set`. A
   * deadline moved into the past has expired.
   */
  shiftDeadline(deltaMs: number): void {
    this.current = { signal: this.current.signal, deadline: new Deadline(deltaMs, this.current.deadline.endsAt) };
  }

  /**
   * Runs `body` with the running phase's deadline brought forward to
   * `timeoutMs` from now, when that is sooner, then puts the phase's own
   * deadline back. Every fixture operation in `body` is capped by it, the way
   * the test deadline caps them, so a wait that would outlast it fails at it
   * with the error a test gets, and one still running when `cancel` aborts
   * is cancelled as the phase's own signal would. One body at a time:
   * `e2e mcp`'s `run_code` caps the code of one call, and a session runs one
   * call at a time.
   */
  async capped<T>(timeoutMs: number, body: () => Promise<T>, cancel?: AbortSignal): Promise<T> {
    const phase = this.current;
    const capped = {
      signal: cancel === undefined ? phase.signal : AbortSignal.any([phase.signal, cancel]),
      deadline: Deadline.min(phase.deadline, new Deadline(timeoutMs)),
    };
    this.current = capped;
    try {
      return await body();
    } finally {
      // A phase entered meanwhile is that phase's to end.
      if (this.current === capped) this.current = phase;
    }
  }
}

/**
 * The test timeout one attempt (or one `beforeAll` hook) runs on, and the
 * race that enforces it. `test.setTimeout` moves it with `set`; `e2e run
 * --step` stops its clock while a step is held. The race reads the budget's
 * deadline again whenever either happens, so a moved deadline takes effect
 * at once and a stopped clock times nothing out.
 */
export class AttemptTimeout {
  private current: number;
  /** What was left when the clock stopped; undefined while it runs. */
  private stoppedMs: number | undefined;
  private timer: { stop(): void; check(): void } | undefined;
  /** Set once the race settled: passed, failed, or timed out with its work still running. */
  private ended = false;

  /**
   * `onMoved` hears what is left each time the clock runs again or `set`
   * moves it while running: the runner's watchdog keeps the deadline too.
   */
  constructor(
    readonly budget: AttemptBudget,
    timeoutMs: number,
    private readonly onMoved?: (remainingMs: number) => void,
  ) {
    this.current = timeoutMs;
  }

  /** The timeout in force: the one given, or what `set` changed it to. */
  get timeoutMs(): number {
    return this.current;
  }

  /**
   * Gives the attempt a timeout of `timeoutMs`, counted from its start like
   * the one it replaces: the deadline moves by the difference, and one moved
   * into the past times the race out at once. While the clock is stopped,
   * what it hands back moves instead. False, changing nothing, once the
   * race settled: code its work left running cannot move the timeout (or
   * the watchdog) any more.
   */
  set(timeoutMs: number): boolean {
    if (this.ended) return false;
    const deltaMs = timeoutMs - this.current;
    this.current = timeoutMs;
    if (this.stoppedMs !== undefined) {
      this.stoppedMs = Math.max(0, this.stoppedMs + deltaMs);
      return true;
    }
    this.budget.shiftDeadline(deltaMs);
    this.onMoved?.(this.budget.clock.remaining());
    this.timer?.check();
    return true;
  }

  /**
   * Stops the clock and keeps what is left. False when the race is on and
   * nothing is left, as after code that blocked the event loop: the race
   * times out now instead, and the clock keeps running.
   */
  stop(): boolean {
    const remainingMs = this.budget.clock.remaining();
    if (remainingMs === 0 && this.timer !== undefined) {
      this.timer.check();
      return false;
    }
    this.timer?.stop();
    this.stoppedMs = remainingMs;
    return true;
  }

  /** Gives the running phase what was left when the clock stopped; the clock stays stopped. */
  refill(): void {
    if (this.stoppedMs !== undefined) this.budget.resetDeadline(this.stoppedMs);
  }

  /** Runs the clock again from what was left when it stopped. */
  start(): void {
    if (this.stoppedMs === undefined) return;
    const remainingMs = this.stoppedMs;
    this.budget.resetDeadline(remainingMs);
    this.stoppedMs = undefined;
    this.timer?.check();
    this.onMoved?.(remainingMs);
  }

  /**
   * Races `work` against the budget's deadline, as read at each check.
   * `onTimeout` builds the error it rejects with. One race at a time.
   */
  race<T>(work: Promise<T>, onTimeout: () => Error): Promise<T> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    let fail: (error: Error) => void = () => undefined;
    const stop = (): void => {
      clearTimeout(handle);
      handle = undefined;
    };
    const check = (): void => {
      stop();
      if (this.stoppedMs !== undefined) return;
      const remaining = this.budget.clock.remaining();
      if (remaining > 0) handle = setTimeout(check, remaining);
      else fail(onTimeout());
    };
    const timer = { stop, check };
    const settled = new Promise<T>((resolve, reject) => {
      fail = reject;
      work.then(resolve, reject);
    });
    const end = (): void => {
      stop();
      this.ended = true;
      if (this.timer === timer) this.timer = undefined;
    };
    settled.then(end, end);
    this.timer = timer;
    check();
    return settled;
  }
}
