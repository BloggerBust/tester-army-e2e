/** The cancellation signal and deadline an attempt's fixtures run under, per phase. */

import { Deadline } from '../internal/time.ts';

/**
 * One attempt's fixture budget. Through `beforeEach` and the body it is the
 * attempt signal and the test deadline. Each `afterEach` hook then enters a
 * budget of its own (every teardown hook has a separate `cleanupTimeout`), so
 * teardown can still drive the app after the body timed
 * out or was cancelled, and a hook that overruns is cancelled without taking
 * the next hook's budget with it. Fixtures read the budget at call time, so a
 * fixture acquired in the body keeps working in teardown.
 */
export class AttemptBudget {
  private current: { readonly signal: AbortSignal; readonly deadline: Deadline };

  constructor(signal: AbortSignal, deadline: Deadline) {
    this.current = { signal, deadline };
  }

  /** The signal the running phase's operations abort with. */
  get signal(): AbortSignal {
    return this.current.signal;
  }

  /** The deadline the running phase's operations are capped by. */
  get deadline(): Deadline {
    return this.current.deadline;
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
   * with the error a test gets. One body at a time: `e2e mcp`'s `run_code`
   * runs its statements one after another.
   */
  async capped<T>(timeoutMs: number, body: () => Promise<T>): Promise<T> {
    const phase = this.current;
    const capped = { signal: phase.signal, deadline: Deadline.min(phase.deadline, new Deadline(timeoutMs)) };
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

  /**
   * A timeout on a budget of its own, for a `beforeAll` hook: no attempt's
   * budget covers it, and nothing cancels through its signal.
   */
  static alone(timeoutMs: number): AttemptTimeout {
    return new AttemptTimeout(new AttemptBudget(new AbortController().signal, new Deadline(timeoutMs)), timeoutMs);
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
    this.onMoved?.(this.budget.deadline.remaining());
    this.timer?.check();
    return true;
  }

  /**
   * Stops the clock and keeps what is left. False when the race is on and
   * nothing is left, as after code that blocked the event loop: the race
   * times out now instead, and the clock keeps running.
   */
  stop(): boolean {
    const remainingMs = this.budget.deadline.remaining();
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
      const remaining = this.budget.deadline.remaining();
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
