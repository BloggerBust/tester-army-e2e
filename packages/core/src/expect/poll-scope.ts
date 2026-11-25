/** Which phase of a test owns an `expect.poll` or `toPass` call, so one left running fails that phase and nothing later. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { markAbandonedRejection, relocateStack } from '../internal/abandoned.ts';
import { pollScopesBrand } from '../internal/brands.ts';
import { TestError, withHint } from '../internal/errors.ts';
import { realmSlot } from '../internal/realm-slot.ts';

interface RunningPoll {
  readonly label: string;
  readonly stack: string | undefined;
  readonly controller: AbortController;
  promise: Promise<unknown>;
  abandoned: boolean;
}

/**
 * The polls one phase started: a test body with its fixtures and
 * `beforeEach` hooks, one teardown, or one suite hook. A poll is not a step
 * and records nothing; what the scope adds is that a poll the phase did not
 * await ends with the phase instead of failing whatever runs when it times out.
 */
export class PollScope {
  private readonly running = new Set<RunningPoll>();
  private closed = false;

  /** `owner` completes "... returned before", as in `the test body`. */
  constructor(private readonly owner: string) {}

  /** Whether the phase has ended: what its work still does then is no test's, whichever one runs now. */
  get over(): boolean {
    return this.closed;
  }

  /**
   * Runs one poll, owned by this scope until it settles. `work` receives the
   * signal that cancels it when the scope closes first. A poll started after
   * the scope closed, by work its phase left running (a body past its
   * timeout), is cancelled before its first read: it belongs to no phase
   * that could still fail, and must not fail the one running now.
   */
  track<T>(label: string, stack: string | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const poll: RunningPoll = { label, stack, controller: new AbortController(), promise: Promise.resolve(), abandoned: false };
    if (this.closed) this.cancel(poll);
    const promise = (async () => {
      try {
        return await work(poll.controller.signal);
      } catch (cause) {
        if (poll.abandoned) markAbandonedRejection(cause);
        throw cause;
      } finally {
        this.running.delete(poll);
      }
    })();
    poll.promise = promise;
    if (poll.abandoned) promise.catch(() => undefined);
    else this.running.add(poll);
    return promise;
  }

  /**
   * Ends the scope when its phase has returned: every poll still running is
   * cancelled and its later rejection observed. Returns the error naming
   * them, at the line of the first, or nothing when every poll had settled.
   * A caller whose phase was cut short (a timeout, a throw) may drop the
   * error: the phase may have been awaiting the poll. Closing twice returns
   * nothing the second time.
   */
  close(): TestError | undefined {
    this.closed = true;
    const polls = [...this.running];
    const [first] = polls;
    if (first === undefined) return undefined;
    for (const poll of polls) this.cancel(poll);
    const more = polls.length > 1 ? ` and ${polls.length - 1} more` : '';
    const error = new TestError(
      'STEP_NOT_AWAITED',
      withHint(`${this.owner} returned before ${first.label}${more} finished`, 'put `await` in front of every expect.poll matcher and toPass call'),
    );
    relocateStack(error, first.stack);
    return error;
  }

  private cancel(poll: RunningPoll): void {
    this.running.delete(poll);
    poll.abandoned = true;
    poll.promise.catch(() => undefined);
    poll.controller.abort();
  }
}

/** Which scope the polls of one async lineage go to; a fixture's lineage moves to its teardown's scope. */
interface PollOwner {
  scope: PollScope | undefined;
  /** Set inside one `expect.poll` read or `toPass` block: the steps it calls are part of the poll or block, which `e2e run --step` never holds. */
  readonly reading?: true;
  /** Signal for cancelling steps when a poll read or `toPass` try is cut short. */
  readonly readSignal?: AbortSignal | undefined;
  /** Set for work that outlives the test it started in, a worker fixture: what it opens is its own to end. */
  readonly outlives?: true;
}

/** The runner's async context, shared through `globalThis` so a test module's copy of `expect` reads it. */
interface PollScopes {
  current(): PollScope | undefined;
  read<T>(run: () => T, signal?: AbortSignal): T;
  reading(): boolean;
  readSignal(): AbortSignal | undefined;
  outlives(): boolean;
}

const storage = new AsyncLocalStorage<PollOwner>();
const scopes: PollScopes = {
  current: () => storage.getStore()?.scope,
  read: (run, signal) => {
    const owner = storage.getStore();
    return enter({ ...owner, scope: owner?.scope, reading: true, readSignal: signal }, run);
  },
  reading: () => storage.getStore()?.reading === true,
  readSignal: () => storage.getStore()?.readSignal,
  outlives: () => storage.getStore()?.outlives === true,
};
const slot = realmSlot<PollScopes>(pollScopesBrand);

/** Runs `run` in the lineage `owner` names, publishing the runner's context for a test module's `expect`. */
function enter<T>(owner: PollOwner, run: () => T): T {
  if (slot.get(globalThis) !== scopes) slot.set(globalThis, scopes);
  return storage.run(owner, run);
}

/**
 * Runs `run` with `scope` owning every poll it starts, however deep in its
 * async work and however long that work outlives the phase: a poll belongs
 * to the phase that started it, never to the one running when it is called.
 */
export function runInPollScope<T>(scope: PollScope, run: () => T): T {
  return enter({ scope }, run);
}

/** One lineage of async work whose polls go to the scope current where it started, until `handOver`. */
export interface PollLineage {
  run<T>(run: () => T): T;
  /** Sends the lineage's polls from now on to the scope current at this call. */
  handOver(): void;
}

/**
 * A lineage for work that spans two phases, a fixture: its setup runs in the
 * body's phase, and the rest of its function after `use` is its teardown's.
 * `outlivesTest` marks a worker fixture's, which no test owns.
 */
export function pollLineage(options: { readonly outlivesTest?: boolean } = {}): PollLineage {
  const owner: PollOwner = { scope: scopes.current(), ...(options.outlivesTest === true ? { outlives: true } : {}) };
  return {
    run: (run) => enter(owner, run),
    handOver: () => {
      owner.scope = scopes.current();
    },
  };
}

/** The scope a poll started here belongs to, or undefined outside any phase (a standalone script). */
export function currentPollScope(): PollScope | undefined {
  return slot.get(globalThis)?.current();
}

/**
 * Runs one `expect.poll` read or `toPass` block, marked so `insidePollRead` sees it in every
 * step the read or block calls. A runner from before the marker publishes a slot
 * without it, and the read or block then runs unmarked.
 */
export function pollRead<T>(run: () => T, signal: AbortSignal): T {
  const shared: Partial<PollScopes> | undefined = slot.get(globalThis);
  if (shared === undefined) return scopes.read(run, signal);
  return typeof shared.read === 'function' ? shared.read(run, signal) : run();
}

/**
 * Whether this async context is work that outlives the test it started in,
 * such as a worker fixture set up by the first test that names it. A runner
 * from before the marker publishes a slot without it, and nothing is then.
 */
export function outlivesTest(): boolean {
  const shared: Partial<PollScopes> | undefined = slot.get(globalThis);
  return typeof shared?.outlives === 'function' && shared.outlives();
}

/**
 * Whether this async context is work its phase left running: a body past its
 * timeout, a promise nobody awaited. A worker fixture's never is; it belongs
 * to no phase.
 */
export function leftRunning(): boolean {
  return currentPollScope()?.over === true && !outlivesTest();
}

/** Whether this async context is inside an `expect.poll` read or a `toPass` block. */
export function insidePollRead(): boolean {
  const shared: Partial<PollScopes> | undefined = slot.get(globalThis);
  return typeof shared?.reading === 'function' && shared.reading();
}

/** Returns the signal for the poll read or `toPass` try in the current async context. */
export function pollReadSignal(): AbortSignal | undefined {
  const shared: Partial<PollScopes> | undefined = slot.get(globalThis);
  return shared?.readSignal?.();
}
