/**
 * The fixture types of the public SDK: scopes, the fixtures that outlive a
 * test, and what `test.extend()` takes. Re-exported from `types.ts`.
 */

/**
 * How long one fixture instance lives. `test`, the default, is one instance
 * per test attempt that names it, shared by its `beforeEach` hooks, its
 * body, and its `afterEach` hooks. `worker` is one instance per worker and
 * target, set up the first time a test or suite hook names it and torn down
 * when the worker ends.
 */
export type FixtureScope = 'test' | 'worker';

/**
 * The fixtures that outlive a test: what `beforeAll`, `afterAll`, and a
 * worker-scoped `test.extend()` fixture receive. An engine whose state
 * outlives an attempt (a device keeps permissions and installed apps) adds
 * its own fixtures, `app`, and `screen` here; on an engine that gives each
 * attempt a fresh surface (a browser context) they are test fixtures.
 */
export interface WorkerFixtures {
  /** The target's platform label: `web`, `ios`, `android`, or an engine's own string. */
  readonly platform: string;
}

/** @deprecated `beforeAll` and `afterAll` receive the worker fixtures: use `WorkerFixtures`. */
export type SuiteFixtures = WorkerFixtures;

/**
 * Defines one fixture: everything before `await use(value)` is its setup,
 * everything after is its teardown. The fixtures it destructures in its
 * first parameter are the ones it depends on, set up before it; one that
 * needs none writes `async ({}, use) => {}`. The body, its hooks, and the
 * fixtures that name it run while `use` is pending; it resolves once they
 * are done, whether or not the body failed.
 */
export type FixtureFn<Fixtures, Value> = (
  fixtures: Fixtures,
  use: (value: Value) => Promise<void>,
) => Promise<void>;
/**
 * A test fixture: its function, or the function and its options. With
 * `auto: true` it is set up for every test of its chain, whether or not
 * anything names it.
 */
export type TestFixtureDefinition<Fixtures, Value> =
  | FixtureFn<Fixtures, Value>
  | readonly [FixtureFn<Fixtures, Value>, { readonly scope?: 'test'; readonly auto?: boolean }];
/**
 * A worker fixture: its function and `{ scope: 'worker' }`. It sees worker
 * fixtures only. With `auto: true` it is set up once per worker, before the
 * first test or suite hook of its chain, whether or not anything names it.
 */
export type WorkerFixtureDefinition<Worker, Value> = readonly [
  FixtureFn<Worker, Value>,
  { readonly scope: 'worker'; readonly auto?: boolean },
];
/**
 * One definition per fixture `test.extend()` adds: `Extra` holds the test
 * fixtures, `ExtraWorker` the worker fixtures. A definition sees the fixtures
 * of the `test` it extends and the ones declared beside it, in any order: it
 * is set up after the ones it names. A test fixture sees every fixture a
 * test sees; a worker fixture sees worker fixtures only, since it outlives
 * every test fixture.
 *
 * A name the base already has is not a new fixture, so declaring it in
 * `Extra` or `ExtraWorker` is a type error. Defined beside them, it extends
 * that fixture, a built-in one included (`FixtureOverrides`): inside its
 * function its own name is the fixture it extends, and it keeps that
 * fixture's type and scope:
 *
 *   base.extend({ app: async ({ app }, use) => { await app.open('/'); await use(app); } })
 */
export type FixtureDefinitions<Base, Extra, Worker = {}, ExtraWorker = {}> = {
  readonly [K in keyof Extra]: K extends keyof Base
    ? never
    : TestFixtureDefinition<Base & NoInfer<Extra> & NoInfer<ExtraWorker>, Extra[K]>;
} & {
  // Not inferred: an `extend({ ... })` without type arguments infers its test
  // fixtures from the definitions, as before worker fixtures; a worker
  // fixture is declared through the second type argument.
  readonly [K in keyof NoInfer<ExtraWorker>]: K extends keyof Base | keyof Extra
    ? never
    : WorkerFixtureDefinition<Worker & NoInfer<ExtraWorker>, NoInfer<ExtraWorker>[K]>;
} & FixtureOverrides<Base & NoInfer<Extra> & NoInfer<ExtraWorker>, Worker & NoInfer<ExtraWorker>, Base, Worker>;
/**
 * Fixtures that extend ones the base already has, each optional. `Sees` and
 * `WorkerSees` are what an override's function receives: the base's
 * fixtures, and the ones declared beside it.
 */
export type FixtureOverrides<Sees, WorkerSees, Base = Sees, Worker = WorkerSees> = {
  readonly [K in keyof Base]?: FixtureOverride<Base, Worker, K, Sees, WorkerSees>;
};
/**
 * A fixture that extends `K`, one the base already has: it hands over the
 * same type and keeps the scope, so the override of a worker fixture
 * receives worker fixtures (`WorkerSees`) only.
 */
export type FixtureOverride<Base, Worker, K extends keyof Base, Sees, WorkerSees> = K extends keyof Worker
  ? FixtureFn<WorkerSees, Base[K]> | WorkerFixtureDefinition<WorkerSees, Base[K]>
  : TestFixtureDefinition<Sees, Base[K]>;
