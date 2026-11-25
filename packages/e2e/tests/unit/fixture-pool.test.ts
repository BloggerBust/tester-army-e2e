/** One fixture pool: what a piece of code names is planned, a chain's test fixtures set up per attempt, its worker fixtures per worker, and what each function receives. */

import { describe, expect, it, vi } from 'vitest';
import { checkDeclaredFixtures, planAttempt, planSuiteHook, type FixturePlan } from '../../src/collect/fixture-plan.ts';
import type { FixtureDefinition, SuiteHook, TestBody, TestHook } from '../../src/collect/registry.ts';
import { attemptBuiltIns, attemptlessBuiltIns, bindFixtures, WorkerFixturePool, type BoundFixtures } from '../../src/run/fixture-pool.ts';
import type { BuiltInTarget } from '@e2e-dev/core/lib/run/fixtures';
import type { FixtureScope } from '@e2e-dev/core/lib/types';

/** A web-like target, whose attempts are isolated, or a device-like one, whose state outlives them. */
function toyTarget(isolation: 'attempt' | 'worker' = 'attempt'): BuiltInTarget {
  return { name: 'toy', platform: 'toy', engine: { name: 'toy', isolation, fixtures: { gadget: () => ({}) } }, fixtureScopes: new Map() };
}

type Fixtures = Record<string, unknown>;
type Use = (value: unknown) => Promise<void>;

interface FixtureOptions {
  /** The scope it declares; `undefined`, spelled out, for a plain function, which declares none. */
  readonly scope?: FixtureScope | undefined;
  /** Whether it declares `auto`; `undefined`, spelled out, for one that does not say. */
  readonly auto?: boolean | undefined;
  /** The `test.extend()` call that declares it, from 0. */
  readonly layer?: number;
  /** The fixtures its function names. */
  readonly uses?: readonly string[];
}

function fixture(name: string, run: (fixtures: Fixtures, use: Use) => Promise<void>, options: FixtureOptions = {}): FixtureDefinition {
  return {
    name,
    scope: 'scope' in options ? options.scope : 'test',
    auto: 'auto' in options ? options.auto : false,
    layer: options.layer ?? 0,
    fn: (fixtures, use) => run(fixtures as Fixtures, use),
    names: options.uses ?? [],
    source: { file: '/repo/tests/support.ts', line: 7, column: 1 },
  };
}

/** A fixture that logs its setup, hands `value` over, and logs its teardown. */
function logged(log: string[], name: string, value: unknown, options: FixtureOptions = {}): FixtureDefinition {
  return fixture(
    name,
    async (_fixtures, use) => {
      log.push(`setup:${name}`);
      await use(value);
      log.push(`teardown:${name}`);
    },
    options,
  );
}

/** A test whose body names `names`, registered through `chain`. */
/** What each test body or hook built here was handed when the pool called it. */
const received = new WeakMap<TestBody, Fixtures>();

/** A body that keeps what it is handed, reading every fixture the way destructuring them all would. */
function receiving(): TestBody {
  const fn: TestBody = (fixtures) => void received.set(fn, { ...(fixtures as Fixtures) });
  return fn;
}

function testNaming(chain: readonly FixtureDefinition[], names: readonly string[]) {
  return { kind: 'test' as const, titlePath: ['suite', 'case'], fn: receiving(), names, source: { file: '/repo/tests/a.e2e.ts', line: 3, column: 1 }, fixtures: chain };
}

function hookNaming<Kind extends 'beforeEach' | 'afterEach' | 'beforeAll' | 'afterAll'>(kind: Kind, chain: readonly FixtureDefinition[], names: readonly string[]) {
  return { kind, fn: receiving(), names, fixtures: chain, group: undefined, declarationIndex: 0, source: { file: '/repo/tests/a.e2e.ts', line: 9, column: 1 } };
}

/** Has the pool call `user`, and returns the fixtures it was handed. */
async function call(bound: BoundFixtures, user: Parameters<BoundFixtures['call']>[0]): Promise<Fixtures> {
  await bound.call(user);
  return received.get(user.fn)!;
}

const plannedNames = (plan: FixturePlan): string[] => plan.order.map(({ definition }) => definition.name);
const plannedScope = (plan: FixturePlan, definition: FixtureDefinition): FixtureScope | undefined => plan.order.find((planned) => planned.definition === definition)?.scope;

interface AttemptOptions {
  readonly pool?: WorkerFixturePool;
  readonly signal?: AbortSignal;
  readonly target?: BuiltInTarget;
  readonly builtIns?: object;
  readonly hooks?: readonly TestHook[];
}

/**
 * Binds `chain` for one attempt of a test that names `names`, with `builtIns`
 * standing in for the attempt's own fixtures. `body()` has the pool call the
 * test body and returns what it was handed.
 */
function attempt(chain: readonly FixtureDefinition[], names: readonly string[], options: AttemptOptions = {}) {
  const target = options.target ?? toyTarget();
  const test = testNaming(chain, names);
  const bound = bindFixtures({
    plan: planAttempt(target, test, options.hooks ?? []),
    builtIns: attemptBuiltIns(options.builtIns ?? { platform: 'toy' }),
    pool: options.pool ?? new WorkerFixturePool(target),
    signal: options.signal,
  });
  return { ...bound, body: () => call(bound, test) };
}

function suiteHook(chain: readonly FixtureDefinition[], names: readonly string[]): SuiteHook {
  return hookNaming('beforeAll', chain, names);
}

const planError = (message: string) => expect.objectContaining({ code: 'COLLECTION_ERROR', message: expect.stringContaining(message) });

describe('planning', () => {
  it('sets up only the fixtures the test names', async () => {
    const log: string[] = [];
    const bound = attempt([logged(log, 'a', 'A'), logged(log, 'b', 'B'), logged(log, 'c', 'C')], ['b']);
    await bound.setUp();
    expect(log).toEqual(['setup:b']);
    // The body is handed the fixtures it names, and nothing else.
    expect(await bound.body()).toEqual({ b: 'B' });
  });

  it('hands a function a built-in when it destructures it, not before', async () => {
    const reads: string[] = [];
    const builtIns = {
      get app() {
        reads.push('app');
        return 'the app';
      },
      platform: 'toy',
    };
    const chain = [logged([], 'a', 'A')];
    const test = { ...testNaming(chain, ['app', 'a']), fn: (() => undefined) as TestBody };
    const bound = bindFixtures({ plan: planAttempt(toyTarget(), test, []), builtIns: attemptBuiltIns(builtIns), pool: new WorkerFixturePool(toyTarget()) });
    await bound.setUp();
    await bound.call(test);
    expect(reads).toEqual([]);
    const reader = { ...test, fn: (({ app, a }: Fixtures) => void reads.push(`body:${String(app)}:${String(a)}`)) as TestBody };
    const again = bindFixtures({ plan: planAttempt(toyTarget(), reader, []), builtIns: attemptBuiltIns(builtIns), pool: new WorkerFixturePool(toyTarget()) });
    await again.setUp();
    await again.call(reader);
    expect(reads).toEqual(['app', 'body:the app:A']);
  });

  it('sets up nothing for a test that names no fixture', async () => {
    const log: string[] = [];
    const bound = attempt([logged(log, 'a', 'A'), logged(log, 'database', 'D', { scope: 'worker' })], []);
    await bound.setUp();
    expect(log).toEqual([]);
    expect(bound.teardowns()).toEqual([]);
  });

  it('sets up what a fixture names before it, through every fixture in between', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const chain = [
      logged(log, 'unused', 'U'),
      logged(log, 'server', 'S', { scope: 'worker' }),
      logged(log, 'client', 'C', { layer: 1, uses: ['server'] }),
      fixture('page', async ({ client, platform }, use) => {
        log.push('setup:page');
        seen.push(client, platform);
        await use('P');
      }, { layer: 2, uses: ['client', 'platform'] }),
    ];
    const bound = attempt(chain, ['page']);
    await bound.setUp();
    expect(log).toEqual(['setup:server', 'setup:client', 'setup:page']);
    expect(seen).toEqual(['C', 'toy']);
    // The worker's `server` is the pool's to tear down.
    expect(bound.teardowns().map((teardown) => teardown.name)).toEqual(['page', 'client']);
  });

  it('orders the fixtures of one extend() call by what they name, whatever order they are written in', async () => {
    const log: string[] = [];
    const chain = [logged(log, 'member', 'M', { uses: ['owner'] }), logged(log, 'owner', 'O'), logged(log, 'other', 'X')];
    await attempt(chain, ['member', 'other']).setUp();
    expect(log).toEqual(['setup:owner', 'setup:member', 'setup:other']);
  });

  it('sets up a fixture written later before the one that names it after an engine fixture', async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const reading = (name: string, uses: readonly string[], options: FixtureOptions = {}) =>
      fixture(name, async (fixtures, use) => {
        log.push(`setup:${name}`);
        seen.push(fixtures.owner);
        await use(name);
      }, { ...options, uses });
    const chain = [
      reading('afterBuiltIn', ['app', 'owner']),
      reading('afterEngineFixture', ['gadget', 'owner']),
      reading('afterEngineUser', ['afterBuiltIn', 'late']),
      logged(log, 'owner', 'O'),
      logged(log, 'late', 'L'),
    ];
    const names = ['afterBuiltIn', 'afterEngineFixture', 'afterEngineUser'];
    const plan = planAttempt(toyTarget(), testNaming(chain, names), []);
    expect(plannedNames(plan)).toEqual(['owner', 'afterBuiltIn', 'afterEngineFixture', 'late', 'afterEngineUser']);
    expect(plan.usesEngine).toBe(true);
    await attempt(chain, names, { builtIns: { app: {}, gadget: {}, platform: 'toy' } }).setUp();
    expect(log).toEqual(['setup:owner', 'setup:afterBuiltIn', 'setup:afterEngineFixture', 'setup:late', 'setup:afterEngineUser']);
    expect(seen).toEqual(['O', 'O', undefined]);
  });

  it('resolves the attempt as one unit: what its beforeEach and afterEach hooks name is set up with what the body names', async () => {
    const log: string[] = [];
    const chain = [logged(log, 'a', 'A'), logged(log, 'b', 'B'), logged(log, 'c', 'C'), logged(log, 'd', 'D')];
    const bound = attempt(chain, ['b'], { hooks: [hookNaming('beforeEach', chain, ['a']), hookNaming('afterEach', chain, ['c'])] });
    await bound.setUp();
    expect(log).toEqual(['setup:a', 'setup:b', 'setup:c']);
  });

  it('sets an auto fixture up for every test, and its worker-scoped kind once per worker', async () => {
    const log: string[] = [];
    const target = toyTarget();
    const pool = new WorkerFixturePool(target);
    const chain = [
      logged(log, 'install', undefined, { scope: 'worker', auto: true }),
      logged(log, 'needed', 'N'),
      logged(log, 'watch', undefined, { auto: true, layer: 1, uses: ['needed'] }),
      logged(log, 'idle', 'I', { layer: 1 }),
    ];
    for (const _ of [1, 2]) {
      const bound = attempt(chain, [], { pool, target });
      await bound.setUp();
      for (const teardown of bound.teardowns()) await teardown.run();
    }
    expect(log).toEqual([
      'setup:install', 'setup:needed', 'setup:watch', 'teardown:watch', 'teardown:needed',
      'setup:needed', 'setup:watch', 'teardown:watch', 'teardown:needed',
    ]);
  });

  it('names the cycle when fixtures need each other', () => {
    const chain = [logged([], 'a', 'A', { uses: ['b'] }), logged([], 'b', 'B', { uses: ['c'] }), logged([], 'c', 'C', { uses: ['a'] }), logged([], 'd', 'D', { uses: ['d'] })];
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['b']), [])).toThrow(planError('fixtures depend on each other in a cycle: "b" -> "c" -> "a" -> "b"'));
    // A fixture that names itself extends the one before it, and here there is none.
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['d']), [])).toThrow(planError('fixture "d" names "d": target "toy" has no "d" fixture; available: a, agent, app, b, c, gadget, platform, request, screen, session'));
    // Found where the fixtures are declared too, before any target is known.
    expect(() => checkDeclaredFixtures(chain, chain)).toThrow(planError('cycle: "a" -> "b" -> "c" -> "a"'));
    // A cycle nothing names is not this test's.
    expect(plannedNames(planAttempt(toyTarget(), testNaming([...chain, logged([], 'e', 'E', { layer: 1 })], ['e']), []))).toEqual(['e']);
  });

  it('refuses a name the target has no fixture for, with the nearest name or the e2e way', () => {
    const chain = [logged([], 'workspace', 'W')];
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['workspce']), [])).toThrow(
      planError('test "suite > case" names "workspce": target "toy" has no "workspce" fixture; available: agent, app, gadget, platform, request, screen, session, workspace (engine toy contributes gadget); did you mean "workspace"?'),
    );
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['page']), [])).toThrow(planError('there is no Playwright page: open the app with app.open()'));
    expect(() => planAttempt(toyTarget(), testNaming([], []), [hookNaming('beforeEach', chain, ['workspace'])])).toThrow(planError('beforeEach hook names "workspace": target "toy" has no "workspace" fixture'));
    expect(() => planAttempt(toyTarget(), testNaming([logged([], 'a', 'A', { uses: ['nope'] })], ['a']), [])).toThrow(planError('fixture "a" names "nope": target "toy" has no "nope" fixture'));
  });

  it('refuses a fixture that names one a later extend() declares', () => {
    const chain = [logged([], 'early', 'E', { uses: ['late'] }), logged([], 'late', 'L', { layer: 1 })];
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['early']), [])).toThrow(planError('fixture "early" names "late", which a later test.extend() declares'));
  });

  it('refuses a worker fixture that names a test fixture, where it is declared when the scope is known by then', () => {
    const page = logged([], 'page', 'P');
    const cache = logged([], 'cache', 'C', { scope: 'worker', layer: 1, uses: ['page'] });
    expect(() => checkDeclaredFixtures([page, cache], [cache])).toThrow(planError('worker fixture "cache" names "page", a test fixture: beforeAll, afterAll, and worker fixtures see worker fixtures only'));
    const session = logged([], 'token', 'T', { scope: 'worker', uses: ['agent'] });
    expect(() => checkDeclaredFixtures([session], [session])).toThrow(planError('worker fixture "token" names "agent", a test fixture'));
    // `app` is a test fixture on one engine and a worker fixture on another: decided per target.
    const opener = logged([], 'opener', 'O', { scope: 'worker', uses: ['app', 'gadget'] });
    expect(() => checkDeclaredFixtures([opener], [opener])).not.toThrow();
    expect(() => planAttempt(toyTarget(), testNaming([opener], ['opener']), [])).toThrow(planError('worker fixture "opener" names "app", a test fixture on target "toy"'));
    expect(plannedNames(planAttempt(toyTarget('worker'), testNaming([opener], ['opener']), []))).toEqual(['opener']);
  });

  it('carries where the offending code was declared', () => {
    const chain = [logged([], 'a', 'A', { uses: ['nope'] })];
    const declaredAt = (plan: () => unknown): unknown => {
      try {
        plan();
      } catch (cause) {
        return (cause as { declaredAt?: unknown }).declaredAt;
      }
      return undefined;
    };
    expect(declaredAt(() => planAttempt(toyTarget(), testNaming(chain, ['a']), []))).toEqual({ file: '/repo/tests/support.ts', line: 7, column: 1 });
    expect(declaredAt(() => planAttempt(toyTarget(), testNaming(chain, ['nope']), []))).toEqual({ file: '/repo/tests/a.e2e.ts', line: 3, column: 1 });
    expect(declaredAt(() => planSuiteHook(toyTarget(), suiteHook(chain, ['app'])))).toEqual({ file: '/repo/tests/a.e2e.ts', line: 9, column: 1 });
  });

  it('says whether the code reaches the engine, itself or through a fixture it names', () => {
    const target = toyTarget('worker');
    const chain = [
      logged([], 'database', 'D', { scope: 'worker', uses: ['platform'] }),
      logged([], 'keeper', 'K', { scope: 'worker', uses: ['gadget'] }),
      logged([], 'holder', 'H', { scope: 'worker', layer: 1, uses: ['keeper'] }),
    ];
    const usesEngine = (names: readonly string[]): boolean => planSuiteHook(target, suiteHook(chain, names)).usesEngine;
    expect(usesEngine([])).toBe(false);
    expect(usesEngine(['platform', 'database'])).toBe(false);
    expect(usesEngine(['app'])).toBe(true);
    expect(usesEngine(['gadget'])).toBe(true);
    expect(usesEngine(['keeper'])).toBe(true);
    expect(usesEngine(['holder'])).toBe(true);
    const plan = planSuiteHook(target, suiteHook(chain, ['database', 'holder']));
    expect(plan.order.map((planned) => [planned.definition.name, planned.usesEngine])).toEqual([['database', false], ['keeper', true], ['holder', true]]);
    // An auto worker fixture that drives the device makes every suite hook of its chain need the engine.
    expect(planSuiteHook(target, suiteHook([logged([], 'install', undefined, { scope: 'worker', auto: true, uses: ['gadget'] })], [])).usesEngine).toBe(true);
  });
});

describe('fixtures that extend a built-in', () => {
  /** A fixture named `name` that names itself, wraps what it received as `{ wraps, by }`, and logs. */
  function wrapping(log: string[], name: string, by: string, options: FixtureOptions = { scope: undefined }): FixtureDefinition {
    return fixture(name, async (fixtures, use) => {
      log.push(`setup:${by}`);
      await use({ wraps: fixtures[name], by });
      log.push(`teardown:${by}`);
    }, { ...options, uses: [name, ...(options.uses ?? [])] });
  }

  it('hands the built-in to the override under its own name, and the override to everyone else', async () => {
    const log: string[] = [];
    const original = { id: 'original app' };
    const seen: unknown[] = [];
    const chain = [
      fixture('reader', async ({ app }, use) => {
        seen.push(app);
        await use('R');
      }, { uses: ['app'] }),
      wrapping(log, 'app', 'override', { scope: undefined, layer: 1 }),
    ];
    const builtIns = { app: original, platform: 'toy' };
    const plan = planAttempt(toyTarget(), testNaming(chain, ['app', 'reader']), []);
    expect(plannedNames(plan)).toEqual(['app', 'reader']);
    expect(plannedScope(plan, chain[1]!)).toBe('test');
    const bound = attempt(chain, ['app', 'reader'], { builtIns });
    await bound.setUp();
    const wrapped = { wraps: original, by: 'override' };
    expect(await bound.body()).toEqual({ app: wrapped, reader: 'R' });
    // A fixture of an earlier extend() that names the built-in gets the override too.
    expect(seen).toEqual([wrapped]);
    // The attempt's own built-ins, which the runner reads, are untouched.
    expect(builtIns.app).toBe(original);
    for (const teardown of bound.teardowns()) await teardown.run();
    expect(log).toEqual(['setup:override', 'teardown:override']);
  });

  it('sets the override up only for code that names the built-in', async () => {
    const log: string[] = [];
    const chain = [wrapping(log, 'app', 'override')];
    const bound = attempt(chain, ['platform'], { builtIns: { app: 'original', platform: 'toy' } });
    await bound.setUp();
    expect(log).toEqual([]);
    expect(await bound.body()).toEqual({ platform: 'toy' });
  });

  it('chains overrides: each receives the one before it', async () => {
    const log: string[] = [];
    const chain = [wrapping(log, 'app', 'first'), wrapping(log, 'app', 'second', { scope: undefined, layer: 1 }), wrapping(log, 'app', 'third', { scope: 'test', layer: 2 })];
    const bound = attempt(chain, ['app'], { builtIns: { app: 'original', platform: 'toy' } });
    await bound.setUp();
    expect(await bound.body()).toEqual({ app: { by: 'third', wraps: { by: 'second', wraps: { by: 'first', wraps: 'original' } } } });
    for (const teardown of bound.teardowns()) await teardown.run();
    expect(log).toEqual(['setup:first', 'setup:second', 'setup:third', 'teardown:third', 'teardown:second', 'teardown:first']);
  });

  it('replaces the built-in for user code when the override does not name it', async () => {
    const chain = [fixture('app', async (_fixtures, use) => use('mine'), { scope: undefined })];
    const bound = attempt(chain, ['app'], { builtIns: { app: 'original', platform: 'toy' } });
    await bound.setUp();
    expect(await bound.body()).toEqual({ app: 'mine' });
  });

  it("runs an override declared with scope 'worker' once per worker, where the engine's state outlives a test", async () => {
    const log: string[] = [];
    const target = toyTarget('worker');
    const pool = new WorkerFixturePool(target);
    const chain = [wrapping(log, 'gadget', 'override', { scope: 'worker' })];
    const gadgetOf = (id: string) => ({ gadget: { id: () => id }, platform: 'toy' });
    const read = (fixtures: Fixtures): string => (fixtures['gadget'] as { wraps: { id(): string } }).wraps.id();

    const inHook = attemptBuiltIns(gadgetOf('hook'));
    const leaveHook = pool.enter(inHook);
    const hook = suiteHook(chain, ['gadget']);
    const hookPlan = planSuiteHook(target, hook);
    expect(plannedScope(hookPlan, chain[0]!)).toBe('worker');
    expect(hookPlan.usesEngine).toBe(true);
    const boundHook = bindFixtures({ plan: hookPlan, builtIns: inHook, pool });
    await boundHook.setUp();
    const fromHook = await call(boundHook, hook);
    expect(read(fromHook)).toBe('hook');
    leaveHook();

    // One instance for the worker: the next attempt gets it, and what it wraps follows the attempt.
    const inAttempt = gadgetOf('attempt');
    pool.enter(attemptBuiltIns(inAttempt));
    const bound = attempt(chain, ['gadget'], { pool, target, builtIns: inAttempt });
    await bound.setUp();
    const fromBody = await bound.body();
    expect(fromBody['gadget']).toBe(fromHook['gadget']);
    expect(read(fromBody)).toBe('attempt');
    expect(bound.teardowns()).toEqual([]);
    expect(log).toEqual(['setup:override']);
    expect(pool.close().map(({ name, usesEngine }) => ({ name, usesEngine }))).toEqual([{ name: 'gadget', usesEngine: true }]);
    // On an engine that isolates each attempt, the built-in is a test fixture, which a worker fixture cannot name.
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['gadget']), [])).toThrow(planError('worker fixture "gadget" names "gadget", a test fixture on target "toy"'));
  });

  it('makes an override a test fixture unless it declares a scope, even where the built-in is a worker fixture', async () => {
    const log: string[] = [];
    const chain = [wrapping(log, 'gadget', 'override')];
    const target = toyTarget('worker');
    expect(plannedScope(planAttempt(target, testNaming(chain, ['gadget']), []), chain[0]!)).toBe('test');
    expect(() => planSuiteHook(target, suiteHook(chain, ['gadget']))).toThrow(planError('beforeAll hook names "gadget", a test fixture on target "toy"'));
    const test = [wrapping(log, 'gadget', 'override', { scope: 'test' })];
    expect(plannedScope(planAttempt(target, testNaming(test, ['gadget']), []), test[0]!)).toBe('test');
    // An override of an earlier fixture of the chain takes no scope from it either.
    const chained = [wrapping([], 'app', 'first', { scope: 'test' }), wrapping([], 'app', 'second', { scope: 'worker', layer: 1 })];
    expect(() => checkDeclaredFixtures(chained, [chained[1]!])).toThrow(planError('worker fixture "app" names "app", a test fixture'));

    const bound = attempt(chain, ['gadget'], { target, builtIns: { gadget: 'original', platform: 'toy' } });
    await bound.setUp();
    expect(await bound.body()).toEqual({ gadget: { wraps: 'original', by: 'override' } });
    for (const teardown of bound.teardowns()) await teardown.run();
    expect(log).toEqual(['setup:override', 'teardown:override']);
  });

  it('lets a worker fixture name an extended app only through a worker-scoped override', () => {
    const chain = [
      wrapping([], 'app', 'first', { scope: 'worker' }),
      logged([], 'seeded', 'S', { scope: 'worker', layer: 1, uses: ['app'] }),
    ];
    expect(() => checkDeclaredFixtures(chain, chain)).not.toThrow();
    expect(plannedNames(planAttempt(toyTarget('worker'), testNaming(chain, ['seeded']), []))).toEqual(['app', 'seeded']);
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['seeded']), [])).toThrow(planError('worker fixture "app" names "app", a test fixture on target "toy"'));
    const testScoped = [wrapping([], 'app', 'first'), logged([], 'seeded', 'S', { scope: 'worker', layer: 1, uses: ['app'] })];
    expect(() => planAttempt(toyTarget('worker'), testNaming(testScoped, ['seeded']), [])).toThrow(planError('worker fixture "seeded" names "app", a test fixture on target "toy"'));
  });

  it('sets an auto fixture up through an override that names it, and the override only if it declares auto', async () => {
    const log: string[] = [];
    const named = [logged(log, 'seed', 'base', { scope: undefined, auto: true }), wrapping(log, 'seed', 'override', { scope: undefined, auto: undefined, layer: 1 })];
    expect(planAttempt(toyTarget(), testNaming(named, []), []).order).toEqual([]);
    const chain = [logged(log, 'seed', 'base', { scope: undefined, auto: true }), wrapping(log, 'seed', 'override', { scope: undefined, auto: true, layer: 1 })];
    const bound = attempt(chain, []);
    await bound.setUp();
    expect(log).toEqual(['setup:seed', 'setup:override']);
    for (const teardown of bound.teardowns()) await teardown.run();
    expect(log).toEqual(['setup:seed', 'setup:override', 'teardown:override', 'teardown:seed']);
  });

  it('does not set up an auto fixture that an override replaces without naming it', async () => {
    const log: string[] = [];
    const chain = [logged(log, 'seed', 'base', { scope: undefined, auto: true }), logged(log, 'seed', 'replacement', { scope: undefined, auto: true, layer: 1 })];
    const bound = attempt(chain, []);
    await bound.setUp();
    // One setup, the replacement's: `logged` logs the fixture's name, which both share.
    expect(log).toEqual(['setup:seed']);
    expect(planAttempt(toyTarget(), testNaming(chain, []), []).order.map((planned) => planned.definition)).toEqual([chain[1]]);
  });

  it('makes an override of a built-in auto when it declares auto', () => {
    const eager = [wrapping([], 'app', 'override', { scope: undefined, auto: true })];
    expect(() => checkDeclaredFixtures(eager, eager)).not.toThrow();
    expect(planAttempt(toyTarget(), testNaming(eager, []), []).order.map((planned) => planned.definition)).toEqual(eager);
  });

  it('fails on a target that lacks the built-in only when code there names it', () => {
    const chain = [wrapping([], 'device', 'override')];
    expect(planAttempt(toyTarget(), testNaming(chain, ['app']), []).order).toEqual([]);
    expect(() => checkDeclaredFixtures(chain, chain)).not.toThrow();
    expect(() => planAttempt(toyTarget(), testNaming(chain, ['device']), [])).toThrow(
      planError('fixture "device" names "device": target "toy" has no "device" fixture; available: agent, app, gadget, platform, request, screen, session (engine toy contributes gadget)'),
    );
  });
});

describe('test fixtures', () => {
  it('retains cleanup when the attempt aborts immediately after use provides a value', async () => {
    const abort = new AbortController();
    const log: string[] = [];
    const bound = attempt([
      fixture('ready', async (_fixtures, use) => {
        const released = use('ready');
        abort.abort();
        await released;
        log.push('teardown:ready');
      }),
      logged(log, 'later', 'later'),
    ], ['ready', 'later'], { signal: abort.signal });
    await expect(bound.setUp()).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log).toEqual(['teardown:ready']);
  });

  it('abandons setup on abort before teardown is taken, while keeping a provided fixture for cleanup', async () => {
    const abort = new AbortController();
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const log: string[] = [];
    const bound = attempt([
      logged(log, 'ready', 'ready'),
      fixture('slow', async (_fixtures, use) => {
        log.push('setup:slow');
        await waiting;
        await use('slow');
        log.push('teardown:slow');
      }),
      logged(log, 'later', 'later'),
    ], ['ready', 'slow', 'later'], { signal: abort.signal });
    const continuation = bound.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await vi.waitFor(() => expect(log).toEqual(['setup:ready', 'setup:slow']));
    abort.abort();
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:ready', 'setup:slow', 'teardown:slow']);
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['ready']);
    await teardowns[0]!.run();
    expect(log.at(-1)).toBe('teardown:ready');
  });

  it('stops abandoned setup before later fixtures or the body, while releasing the late fixture', async () => {
    const log: string[] = [];
    let finishSetup!: () => void;
    const waiting = new Promise<void>((resolve) => { finishSetup = resolve; });
    const bound = attempt([
      fixture('slow', async (_fixtures, use) => {
        log.push('setup:slow');
        await waiting;
        await use('slow');
        log.push('teardown:slow');
      }),
      logged(log, 'later', 'later'),
    ], ['slow', 'later']);
    const continuation = bound.setUp().then(() => { log.push('body'); });
    const stopped = expect(continuation).rejects.toMatchObject({ code: 'TEST_SETUP_FAILED' });
    await Promise.resolve();
    expect(bound.teardowns()).toEqual([]);
    finishSetup();
    await stopped;
    expect(log).toEqual(['setup:slow', 'teardown:slow']);
  });

  it('tears down the fixtures set up before a later one throws, last first, and says which hooks can still run', async () => {
    const log: string[] = [];
    const chain = [
      logged(log, 'a', 'A'),
      logged(log, 'b', 'B'),
      fixture('c', async () => {
        log.push('setup:c');
        throw new Error('c failed');
      }),
      logged(log, 'd', 'D'),
    ];
    const [setUp, failed, neverReached] = [['a', 'platform'], ['a', 'c'], ['d']].map((names) => hookNaming('afterEach', chain, names));
    const bound = attempt(chain, ['a', 'b', 'c', 'd'], { hooks: [setUp!, failed!, neverReached!] });
    await expect(bound.setUp()).rejects.toThrow('c failed');
    const teardowns = bound.teardowns();
    expect(teardowns.map((teardown) => teardown.name)).toEqual(['b', 'a']);
    for (const teardown of teardowns) await teardown.run();
    expect(log).toEqual(['setup:a', 'setup:b', 'setup:c', 'teardown:b', 'teardown:a']);
    // An afterEach hook that names a fixture whose setup failed, or was never reached, is skipped.
    expect([setUp!, failed!, neverReached!].map((hook) => bound.ready(hook))).toEqual([true, false, false]);
    expect(await call(bound, setUp!)).toEqual({ a: 'A', platform: 'toy' });
  });
});

describe('worker fixtures', () => {
  it('sets one instance up for every attempt of the worker that names it and tears it down when the pool closes', async () => {
    const log: string[] = [];
    const target = toyTarget();
    const pool = new WorkerFixturePool(target);
    const chain = [logged(log, 'database', { rows: 1 }, { scope: 'worker' }), logged(log, 'unused', 'U', { scope: 'worker' }), logged(log, 'page', 'P')];
    for (const _ of [1, 2]) {
      const bound = attempt(chain, ['database', 'page'], { pool, target });
      await bound.setUp();
      expect(await bound.body()).toEqual({ database: { rows: 1 }, page: 'P' });
      for (const teardown of bound.teardowns()) await teardown.run();
    }
    expect(log).toEqual(['setup:database', 'setup:page', 'teardown:page', 'setup:page', 'teardown:page']);
    const teardowns = pool.close();
    expect(teardowns.map(({ name, usesEngine }) => ({ name, usesEngine }))).toEqual([{ name: 'database', usesEngine: false }]);
    for (const teardown of teardowns) await teardown.run();
    expect(log.at(-1)).toBe('teardown:database');
  });

  it('tries a failed setup again for the next attempt that needs it', async () => {
    const target = toyTarget();
    const pool = new WorkerFixturePool(target);
    let tries = 0;
    const flaky = fixture('flaky', async (_fixtures, use) => {
      tries += 1;
      if (tries === 1) throw new Error('first start failed');
      await use(tries);
    }, { scope: 'worker' });
    await expect(attempt([flaky], ['flaky'], { pool, target }).setUp()).rejects.toThrow('first start failed');
    const second = attempt([flaky], ['flaky'], { pool, target });
    await second.setUp();
    expect(await second.body()).toEqual({ flaky: 2 });
  });

  it('hands a worker fixture the worker fixtures it names', async () => {
    const target = toyTarget();
    const seen: string[] = [];
    const chain: FixtureDefinition[] = [
      logged([], 'page', 'P'),
      logged([], 'server', 'S', { scope: 'worker' }),
      fixture('client', async ({ server, platform }, use) => {
        seen.push(`${String(platform)}:${String(server)}`);
        await use('C');
      }, { scope: 'worker', layer: 1, uses: ['server', 'platform'] }),
    ];
    await attempt(chain, ['client'], { target }).setUp();
    expect(seen).toEqual(['toy:S']);
  });

  it('forwards a device-like built-in to whichever attempt is running, and marks the teardown as needing the engine', async () => {
    const target = toyTarget('worker');
    const pool = new WorkerFixturePool(target);
    const held: { gadget?: { id(): string } } = {};
    const keeper = fixture('keeper', async ({ gadget }, use) => {
      held.gadget = gadget as { id(): string };
      await use('kept');
    }, { scope: 'worker', uses: ['gadget'] });
    const gadgetOf = (id: string) => ({ gadget: { id: () => id }, platform: 'toy' });
    const first = gadgetOf('first');
    const leave = pool.enter(attemptBuiltIns(first));
    await attempt([keeper], ['keeper'], { pool, target, builtIns: first }).setUp();
    expect(held.gadget?.id()).toBe('first');
    leave();
    pool.enter(attemptBuiltIns(gadgetOf('second')));
    expect(held.gadget?.id()).toBe('second');
    expect(pool.close().map(({ name, usesEngine }) => ({ name, usesEngine }))).toEqual([{ name: 'keeper', usesEngine: true }]);
  });
});

describe('suite hook fixtures', () => {
  const noAttempt = (name: string): Error => new Error(`"${name}" has no attempt behind it`);

  /** Binds a `beforeAll` hook that names `names`; `builtIns` stands in for its attempt, and without one it has none. */
  function bindHook(target: BuiltInTarget, chain: readonly FixtureDefinition[], names: readonly string[], builtIns?: object) {
    const hook = suiteHook(chain, names);
    const bound = bindFixtures({
      plan: planSuiteHook(target, hook),
      builtIns: builtIns === undefined ? attemptlessBuiltIns(target, noAttempt) : attemptBuiltIns(builtIns),
      pool: new WorkerFixturePool(target),
    });
    return { ...bound, hook: () => call(bound, hook) };
  }

  it('sets up the worker fixtures the hook names and the auto worker fixtures, and no test fixture', async () => {
    const log: string[] = [];
    const target = toyTarget();
    const chain = [
      logged(log, 'page', 'P'),
      logged(log, 'watch', undefined, { auto: true }),
      logged(log, 'install', undefined, { scope: 'worker', auto: true }),
      logged(log, 'database', 'D', { scope: 'worker' }),
      logged(log, 'unused', 'U', { scope: 'worker' }),
    ];
    const bound = bindHook(target, chain, ['database', 'platform']);
    await bound.setUp();
    expect(log).toEqual(['setup:install', 'setup:database']);
    // With no attempt behind it, `platform` is still there: the target alone decides it.
    expect(await bound.hook()).toEqual({ database: 'D', platform: 'toy' });
  });

  it('refuses a test fixture by scope before anything is set up', () => {
    const target = toyTarget();
    const chain = [logged([], 'page', 'P'), logged([], 'database', 'D', { scope: 'worker' })];
    for (const name of ['page', 'gadget', 'screen', 'agent']) {
      expect(() => planSuiteHook(target, suiteHook(chain, ['database', name]))).toThrow(planError(`beforeAll hook names "${name}", a test fixture on target "toy": beforeAll, afterAll, and worker fixtures see worker fixtures only`));
    }
    expect(() => planSuiteHook(target, suiteHook(chain, ['nope']))).toThrow(planError('beforeAll hook names "nope": target "toy" has no "nope" fixture'));
  });

  it('sees the engine fixtures, app, and screen on an engine whose state outlives an attempt', async () => {
    const target = toyTarget('worker');
    const builtIns = { gadget: 'G', app: 'A', screen: 'S', platform: 'toy', agent: 'never read' };
    expect(await bindHook(target, [], ['gadget', 'app', 'screen'], builtIns).hook()).toEqual({ gadget: 'G', app: 'A', screen: 'S' });
    expect(() => planSuiteHook(target, suiteHook([], ['agent']))).toThrow(planError('beforeAll hook names "agent", a test fixture on target "toy"'));
  });

  it('fails a hook that names an engine fixture with no attempt behind it, with the reason, as it destructures it', async () => {
    const target = toyTarget('worker');
    const bound = bindHook(target, [], ['platform', 'gadget']);
    await bound.setUp();
    await expect(bound.hook()).rejects.toThrow('"gadget" has no attempt behind it');
  });
});
