/**
 * The fixture types of the public SDK: scopes, the fixtures that outlive a
 * test, and what `test.extend()` takes. Re-exported from `types.ts`.
 */

import type { EngineHandle, EngineIsolation } from '../engine/index.ts';
import type { TestFixtures } from '../types.ts';

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
 * that fixture, a built-in one included: inside its function its own name is
 * the fixture it extends, and it keeps that fixture's type. The override of
 * a worker fixture is declared with `scope: 'worker'` here, since the
 * fixtures this call returns keep it a worker fixture:
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
} & {
  readonly [K in Extract<keyof Base, PropertyKey>]?: K extends keyof Worker
    ? WorkerFixtureDefinition<Worker & NoInfer<ExtraWorker>, Base[K]>
    : TestFixtureDefinition<Base & NoInfer<Extra> & NoInfer<ExtraWorker>, Base[K]>;
};
/**
 * Fixtures that extend ones the base already has, each optional. `Sees` and
 * `WorkerSees` are what an override's function receives: the base's
 * fixtures, and the ones declared beside it.
 */
export type FixtureOverrides<Sees, WorkerSees, Base = Sees, Worker = WorkerSees> = {
  // Map over keys shared by all members of a union `Base`, such as
  // `ConfigFixtures`. Mapping directly over `keyof Base` would map each
  // member separately. Each override type would then be a union of fixture
  // functions, and the parameter types could not be inferred.
  readonly [K in Extract<keyof Base, PropertyKey>]?: FixtureOverride<Base, Worker, K, Sees, WorkerSees>;
};
/**
 * A fixture that extends `K`, one the base already has: it hands over the
 * same type. Its scope is the one it declares, else `test`, and only the
 * override of a worker fixture can be a worker fixture.
 *
 * The override of a worker fixture with options receives worker fixtures
 * (`WorkerSees`) only, whatever its scope: TypeScript can't type the
 * function of a tuple by the `scope` beside it. A function without options
 * is a test fixture, so it receives every fixture (`Sees`).
 */
export type FixtureOverride<Base, Worker, K extends keyof Base, Sees, WorkerSees> = K extends keyof Worker
  ? FixtureFn<Sees, Base[K]> | readonly [FixtureFn<WorkerSees, Base[K]>, { readonly scope?: FixtureScope; readonly auto?: boolean }]
  : TestFixtureDefinition<Sees, Base[K]>;

/** The names in `Overrides` that are test fixtures: every override not declared with `scope: 'worker'`. */
export type TestOverrides<Overrides> = {
  [K in keyof Overrides]-?: Overrides[K] extends readonly [unknown, { readonly scope: 'worker' }] ? never : K;
}[keyof Overrides];

/**
 * `Worker` without the fixtures in `Names`, one target at a time, so the
 * union of `ConfigFixtures` keeps a member per target.
 */
export type OmitEach<Worker, Names extends PropertyKey> = Worker extends unknown ? Omit<Worker, Names> : never;

/**
 * The fixtures in `Names` that `Worker` has, one target at a time. `platform`
 * is kept, so a member pairs only with the test fixtures of its own target.
 */
export type PickEach<Worker, Names extends PropertyKey> = Worker extends unknown ? Pick<Worker, Extract<Names | 'platform', keyof Worker>> : never;

/**
 * Test or worker fixture types for each target in `Config`, the third type
 * argument of `test.extend`. Each union member is one target, with the
 * fixtures of that target's engine. A fixture that only other targets have
 * is typed as `undefined`, like its runtime value.
 *
 * Engine fixtures, `app`, and `screen` are worker fixtures on a target
 * whose engine has `isolation: 'worker'`, and test fixtures otherwise.
 * The test half has them on every target, so a test still gets `app` and
 * `screen` from a pair of members that a `string` platform keeps.
 * `platform` is in both halves, so an intersection of members with
 * different platforms reduces to `never`.
 */
export type ConfigFixtures<Config, Half extends FixtureScope, Handle = ConfigEngines<Config>> = unknown extends Config
  ? {}
  : Handle extends EngineHandle<infer Fixtures, infer Platform, infer Isolation>
    ? { readonly platform: Platform } & (Half extends ([Isolation] extends ['worker'] ? FixtureScope : 'test')
      ? Pick<TestFixtures, 'app' | 'screen'> & Fixtures
      : {}) & { readonly [Name in Exclude<ConfigFixtureNames<ConfigEngines<Config>>, keyof Fixtures>]?: undefined }
    : never;

/**
 * `Base` without the fixtures that `ConfigFixtures` types per target. Without
 * this, a fixture typed on the base `test` (`device: Device`, say) would keep
 * that type on every target, even where it's `undefined`.
 */
export type ConfigBase<Base, Config> = unknown extends Config ? Base : Omit<Base, ConfigFixtureNames<ConfigEngines<Config>> | 'app' | 'screen'>;

/**
 * `Fixtures` without the targets that a test's `platforms` option skips: a
 * target whose platform isn't in `Platform`. A target whose platform type is
 * `string` is kept for any `Platform`.
 */
export type SelectedFixtures<Fixtures, Platform> = Fixtures extends unknown
  ? Fixtures extends { readonly platform: infer Own }
    ? [Extract<Own, Platform> | Extract<Platform, Own>] extends [never]
      ? never
      : Fixtures
    : Fixtures
  : never;

/**
 * The engine handle of each target in `Config`. A target without an engine
 * has a plain `EngineHandle`. If the engine's platform type is `string`, the
 * target's `platform` is used instead.
 */
type ConfigEngines<Config> = Config extends { readonly targets: readonly (infer Each)[] }
  ? Each extends { readonly engine: EngineHandle<infer Fixtures extends object, infer Platform extends string, infer Isolation extends EngineIsolation> }
    ? EngineHandle<Fixtures, string extends Platform ? TargetPlatform<Each> : Platform, Isolation>
    : EngineHandle<{}, TargetPlatform<Each>>
  : never;

/** The `platform` a target declares, else `string`. */
type TargetPlatform<Target> = Target extends { readonly platform: infer Platform extends string } ? Platform : string;

/**
 * Engine fixture names from `Handle`, excluding core fixtures. Core
 * fixtures such as `app` and `screen` are defined on every target and may
 * have a narrower type on some engines.
 */
type ConfigFixtureNames<Handle> = Handle extends EngineHandle<infer Fixtures> ? Exclude<keyof Fixtures, keyof TestFixtures> : never;
