/**
 * One pool for every fixture a piece of test code reads: the built-in ones
 * (`agent`, `app`, `screen`, `platform`, `request`, `services`, `session`), the target engine's, and
 * the `test.extend()` chain it was registered through. Each has a scope, and
 * code sees the fixtures that live at least as long as it does: a test and
 * its per-test hooks see test and worker fixtures, a suite hook and a worker
 * fixture see worker fixtures only. A chain fixture is set up on demand: for
 * code that names it, for a fixture that names it, or because it is `auto`.
 * The plan (`planAttempt`, `planSuiteHook`) decides all of that before
 * anything runs; the pool sets up what it lists and hands each function the
 * fixtures it names.
 */

import { planAttempt, type FixtureInputs, type FixturePlan, type FixtureUser, type PlannedFixture } from '../collect/fixture-plan.ts';
import type { FixtureDefinition, RegisteredTest, TestBody, TestHook } from '../collect/registry.ts';
import { builtInFixtures, type BuiltInFixtures, type BuiltInTarget } from '@e2e-dev/core/lib/run/fixtures';
import { pollLineage, type PollLineage } from '@e2e-dev/core/lib/expect/poll-scope';
import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';

/** Reads one built-in fixture by name, off whatever attempt runs the code. */
export type BuiltInReader = (name: string) => unknown;

/** The built-in fixtures of an attempt, read lazily off the object `createFixtures` built for it. */
export function attemptBuiltIns(fixtures: object): BuiltInReader {
  return (name) => Reflect.get(fixtures, name) as unknown;
}

/**
 * Returns a built-in fixture reader for code running without an attempt.
 * Only fixtures derived from the target or worker (`platform` and
 * `services`) are available. Reading any other fixture throws the error
 * returned by `unavailable`.
 */
export function attemptlessBuiltIns(target: BuiltInTarget, services: Readonly<Record<string, unknown>>, unavailable: (name: string) => Error): BuiltInReader {
  const builtIns = builtInFixtures(target, services);
  return (name) => {
    if (builtIns.needsAttempt(name)) throw unavailable(name);
    return builtIns.attemptless(name);
  };
}

/** One set-up fixture's teardown: the rest of its function after `use`. */
export interface FixtureTeardown {
  readonly name: string;
  run(): Promise<void>;
}

/** A worker fixture's teardown, which runs when the worker ends, outside any test. */
export interface WorkerFixtureTeardown extends FixtureTeardown {
  /** Whether the fixture names an engine-backed built-in, itself or through a fixture it names: its teardown then needs an attempt. */
  readonly usesEngine: boolean;
}

/**
 * Runs one fixture function until it hands its value to `use`. `accept`
 * receives the value and the fixture's teardown synchronously, at `use`; it
 * returns false when nobody can take the value anymore (the attempt that
 * asked gave up), and the function then runs on detached with `use`
 * resolved at once. Resolves once the value was handed over; rejects with
 * the function's failure, or when it returned without calling `use`.
 * `outlivesTest` says the fixture is a worker's: set up inside the first
 * test that names it, it is no part of that test.
 */
function startFixture(
  definition: FixtureDefinition,
  fixtures: object,
  accept: (value: unknown, teardown: FixtureTeardown) => boolean,
  outlivesTest = false,
): Promise<void> {
  const { name } = definition;
  let ready!: () => void;
  let failed!: (cause: unknown) => void;
  const provided = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let used = false;
  let misuse: ConfigurationError | undefined;
  // The function's polls are its user's until `use` returns, then its teardown's.
  const polls: PollLineage = pollLineage({ outlivesTest });
  const use = (value: unknown): Promise<void> => {
    if (used) {
      misuse = new ConfigurationError(
        'TEST_SETUP_FAILED',
        `fixture "${name}" called use() twice; a fixture hands one value per instance`,
      );
      const rejected = Promise.reject(misuse);
      // The violation is reported at teardown whether or not the fixture awaits this.
      rejected.catch(() => undefined);
      return rejected;
    }
    used = true;
    const teardown: FixtureTeardown = {
      name,
      run: async () => {
        polls.handOver();
        release();
        await run;
        if (misuse !== undefined) throw misuse;
      },
    };
    if (!accept(value, teardown)) {
      // Nobody can take the value, and holding the function here would keep
      // whatever it allocated alive forever.
      release();
    }
    ready();
    return released;
  };
  const run = Promise.resolve()
    .then(() => polls.run(() => definition.fn(fixtures, use)))
    .then(
      () => {
        if (!used) {
          failed(
            new ConfigurationError(
              'TEST_SETUP_FAILED',
              `fixture "${name}" returned without calling use(); a fixture awaits use(value) to hand its value over`,
            ),
          );
        }
      },
      (cause: unknown) => {
        failed(cause);
        throw cause;
      },
    );
  // A fixture whose setup failed is never torn down, and one released
  // detached runs on alone, so nothing else would observe its rejection; a
  // torn-down one is awaited by its teardown.
  run.catch(() => undefined);
  return provided;
}

/**
 * The worker-scoped `test.extend()` fixtures of one worker and target: one
 * instance per fixture, set up the first time a test or suite hook of
 * its chain needs it, and torn down when the worker ends. A module that is
 * evaluated again (the test file after a failed test, a module that
 * registers hooks with each file that imports it) defines its fixtures
 * again, and they keep their instance: a fixture is known by its
 * `identity`, and by the definition itself only where it has none.
 */
export class WorkerFixturePool {
  private readonly instances = new Map<FixtureDefinition | string, Promise<unknown>>();
  private readonly active: WorkerFixtureTeardown[] = [];
  private closed = false;
  /** The built-in fixtures of the attempt or suite hook running now; see `enter`. */
  private current: BuiltInReader | undefined;

  private readonly builtInFixtures: BuiltInFixtures;

  /** `services` holds the service values started by the worker's entry point for the `services` fixture. */
  constructor(target: BuiltInTarget, services: Readonly<Record<string, unknown>> = {}) {
    this.builtInFixtures = builtInFixtures(target, services);
  }

  /**
   * Makes `builtIns` the fixtures a worker fixture's built-ins forward to,
   * until the returned function restores the previous ones. A worker
   * fixture outlives the attempt it was set up in, so it holds a forwarder
   * for `device`, `app`, and `screen`, never one attempt's object: the steps
   * it takes land in the record of whatever runs at the time.
   */
  enter(builtIns: BuiltInReader): () => void {
    const previous = this.current;
    this.current = builtIns;
    return () => {
      this.current = previous;
    };
  }

  /**
   * The value of `definition`, set up on first use with `fixtures`, the
   * worker fixtures it names. A setup that fails is forgotten, so the next
   * test to need the fixture tries again; one still running is shared by
   * everyone who asks meanwhile. `usesEngine` is the plan's word on whether
   * the fixture reaches the engine, kept for its teardown.
   */
  acquire(definition: FixtureDefinition, fixtures: object, usesEngine: boolean): Promise<unknown> {
    const key = definition.identity ?? definition;
    const known = this.instances.get(key);
    if (known !== undefined) return known;
    let value: unknown;
    const instance = startFixture(definition, fixtures, (provided, teardown) => {
      if (this.closed) return false;
      value = provided;
      this.active.push({ ...teardown, usesEngine });
      return true;
    }, true).then(() => value);
    this.instances.set(key, instance);
    instance.catch(() => {
      if (this.instances.get(key) === instance) this.instances.delete(key);
    });
    return instance;
  }

  /**
   * Ends the pool: the teardowns of every fixture whose setup completed, last
   * set up first. A setup still running when the pool closes finds nobody to
   * hand its value to, and its teardown runs detached.
   */
  close(): readonly WorkerFixtureTeardown[] {
    this.closed = true;
    this.instances.clear();
    return this.active.splice(0).toReversed();
  }

  /**
   * Returns built-in fixture `name` for a worker fixture. If the value comes
   * from the target or worker, it's returned directly. Otherwise, it returns
   * an object that forwards to the attempt or suite hook running at the time.
   */
  builtIn(name: string): unknown {
    return this.builtInFixtures.needsAttempt(name) ? this.forwarder(name) : this.builtInFixtures.attemptless(name);
  }

  /** An object that reads `name` off the running attempt's fixtures at each access. */
  private forwarder(name: string): object {
    const resolve = (): object => {
      if (this.current === undefined) {
        throw new ConfigurationError(
          'UNSUPPORTED_CAPABILITY',
          `a worker fixture used "${name}" when no test or suite hook was running`,
        );
      }
      return this.current(name) as object;
    };
    return new Proxy(
      {},
      {
        get: (_, key) => {
          const target = resolve();
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
        has: (_, key) => Reflect.has(resolve(), key),
      },
    );
  }
}

/** A registered test body or hook: what the pool calls with the fixtures it names. */
type BoundUser = FixtureUser & { readonly fn: TestBody };

/** The fixtures set up for one piece of user code, and the way to run that code with them. */
export interface BoundFixtures {
  /**
   * Sets up the fixtures the plan lists, in its order: a worker fixture is
   * taken from the pool (set up there on first use), a test fixture set up
   * for this attempt. Rejects with the first failure; the test fixtures set
   * up before it still get torn down. `starting` hears each fixture's name
   * right before its setup runs.
   */
  setUp(starting?: (fixture: string) => void): Promise<void>;
  /**
   * Runs the test body or hook `user` with the fixtures it names, and no
   * others. A built-in one is acquired as the function destructures it.
   */
  call(user: BoundUser): void | Promise<void>;
  /**
   * Whether every chain fixture `user` names was set up. A hook that names
   * one whose setup failed, or was never reached, has nothing to run with.
   */
  ready(user: FixtureUser): boolean;
  /**
   * The teardowns of the test fixtures whose setup completed, last set up
   * first. Taking them ends setup, as does `signal`: a test fixture still
   * running that reaches `use` afterwards finds no attempt to hand its value
   * to, so `use` resolves at once and its teardown runs detached. Worker
   * fixtures are the pool's to tear down.
   */
  teardowns(): readonly FixtureTeardown[];
}

export interface BindOptions {
  /** What to set up, and what each function receives: `planAttempt` or `planSuiteHook`. */
  readonly plan: FixturePlan;
  /** The built-in fixtures of the attempt the code runs in; see `attemptlessBuiltIns`. */
  readonly builtIns: BuiltInReader;
  readonly pool: WorkerFixturePool;
  /** The attempt's abort signal: setup stops once it fires. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Binds one plan to the code about to run with it: a test attempt, or a
 * suite hook. Every function, a fixture's included, receives a plain object
 * holding the fixtures it names: the value a chain fixture handed over, or a
 * built-in read off the attempt when the function destructures it.
 */
export function bindFixtures(options: BindOptions): BoundFixtures {
  const { plan, builtIns, pool, signal } = options;
  /** The value each fixture handed over. */
  const provided = new Map<FixtureDefinition, unknown>();
  const receive = (inputs: FixtureInputs, builtIn: BuiltInReader): object => {
    const fixtures = {};
    for (const [name, definition] of inputs) {
      Object.defineProperty(
        fixtures,
        name,
        definition === undefined ? { enumerable: true, get: () => builtIn(name) } : { enumerable: true, value: provided.get(definition) },
      );
    }
    return fixtures;
  };
  const inputsOf = (user: FixtureUser): FixtureInputs => {
    const inputs = plan.inputs.get(user);
    if (inputs === undefined) throw new Error('the fixture plan does not cover this test body or hook');
    return inputs;
  };

  const active: FixtureTeardown[] = [];
  let abandoned = signal?.aborted === true;
  const abandon = (): void => {
    abandoned = true;
  };
  if (!abandoned) signal?.addEventListener('abort', abandon, { once: true });
  /** Stops setup once its attempt has given up on it. */
  const requireActive = (): void => {
    if (abandoned) throw new ConfigurationError('TEST_SETUP_FAILED', 'fixture setup ended after the attempt was abandoned');
  };

  const setUpOne = async ({ definition, scope, usesEngine, inputs }: PlannedFixture): Promise<void> => {
    if (scope === 'worker') {
      // A worker fixture outlives this attempt, so a built-in reaches it through the pool, never as this attempt's object.
      provided.set(definition, await pool.acquire(definition, receive(inputs, (name) => pool.builtIn(name)), usesEngine));
      return;
    }
    await startFixture(definition, receive(inputs, builtIns), (value, teardown) => {
      if (abandoned) return false;
      provided.set(definition, value);
      active.push(teardown);
      return true;
    });
  };

  return {
    async setUp(starting): Promise<void> {
      requireActive();
      for (const planned of plan.order) {
        starting?.(planned.definition.name);
        await setUpOne(planned);
        requireActive();
      }
    },
    call: (user) => user.fn(receive(inputsOf(user), builtIns)),
    ready: (user) => [...inputsOf(user).values()].every((definition) => definition === undefined || provided.has(definition)),
    teardowns(): readonly FixtureTeardown[] {
      abandon();
      signal?.removeEventListener('abort', abandon);
      return active.toReversed();
    },
  };
}

/** The `beforeEach` and `afterEach` hooks that apply to one test, each list in the order it runs. */
export interface AttemptHooks {
  readonly beforeEach: readonly TestHook[];
  readonly afterEach: readonly TestHook[];
}

/** A fixture's setup as `StepRecorder.owner` names it. */
export function fixtureSetup(fixture: string): string {
  return `the fixture "${fixture}" setup`;
}

/** One step of an attempt's cleanup: a label for its timeout, and what to run within its own cleanup budget. */
export interface AttemptCleanup {
  readonly label: string;
  run(): void | Promise<void>;
}

/** The fixtures of one test attempt, bound to its built-ins. */
export interface TestAttemptFixtures {
  /** Makes this attempt the one worker fixtures read their built-ins off, until the returned function is called. */
  enter(): () => void;
  /**
   * Sets the fixtures up, runs the `beforeEach` hooks, then the body.
   * `running` is told the phase about to run and the code that runs in it,
   * as `StepRecorder.owner` names it; `signal` stops the sequence between
   * two of them.
   */
  run(running: (phase: 'beforeEach' | 'body', owner: string) => void, signal: AbortSignal): Promise<void>;
  /**
   * What the attempt leaves to clean up: the `afterEach` hooks, then the test
   * fixtures' teardowns, last set up first. A hook that names a fixture
   * whose setup failed is left out. Taking the list ends fixture setup.
   */
  cleanup(): readonly AttemptCleanup[];
}

/**
 * Plans the fixtures of one attempt of `test` on `target`, resolved as one
 * unit over its body and `hooks`, before any session exists: a fixture rule
 * one of them breaks throws here. `open` binds the plan to the attempt once
 * its built-in fixtures exist.
 */
export function planAttemptFixtures(
  target: BuiltInTarget,
  test: RegisteredTest,
  hooks: AttemptHooks,
): { open(options: { readonly builtIns: object; readonly pool: WorkerFixturePool; readonly signal: AbortSignal }): TestAttemptFixtures } {
  const plan = planAttempt(target, test, [...hooks.beforeEach, ...hooks.afterEach]);
  return {
    open({ builtIns, pool, signal }) {
      const read = attemptBuiltIns(builtIns);
      const bound = bindFixtures({ plan, builtIns: read, pool, signal });
      return {
        enter: () => pool.enter(read),
        async run(running, stop) {
          running('beforeEach', 'the beforeEach hook');
          await bound.setUp((fixture) => running('beforeEach', fixtureSetup(fixture)));
          stop.throwIfAborted();
          for (const hook of hooks.beforeEach) {
            running('beforeEach', 'the beforeEach hook');
            await bound.call(hook);
            stop.throwIfAborted();
          }
          running('body', 'the test body');
          await bound.call(test);
        },
        cleanup: () => [
          ...hooks.afterEach.filter((hook) => bound.ready(hook)).map((hook) => ({ label: `${hook.kind} hook`, run: () => bound.call(hook) })),
          ...bound.teardowns().map((teardown) => ({ label: `fixture "${teardown.name}" teardown`, run: teardown.run })),
        ],
      };
    },
  };
}
