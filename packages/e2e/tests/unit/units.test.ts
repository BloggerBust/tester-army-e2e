import { describe, expect, it } from 'vitest';
import type { CollectedFile, CollectedTest, Collection } from '../../src/collect/collect.ts';
import type {
  ResolvedTestOptions,
  Selection,
  TestTargetPair,
} from '../../src/collect/select.ts';
import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import { protocolEngine } from '@e2e-dev/core/lib/engine/protocol/client';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import {
  buildWorkPlans,
  failureLimitSkip,
  interruptedInPhase,
  nonRunResult,
  orderWorkPlans,
  timeLimitSkip,
  unstartedResult,
  withWorkerCap,
  type TargetWorkPlan,
} from '../../src/run/units.ts';
import { decodeResult } from '../../src/run/worker/protocol.ts';
import { encodeResult, type ResultRecord } from '@e2e-dev/core/lib/run/records';

const EMPTY_APP: ResolvedTarget['app'] = {
  base: undefined,
  portRequest: undefined,
  site: undefined,
  environment: 'test',
  identity: undefined,
  bundleId: undefined,
  appPath: undefined,
  linkBase: undefined,
  launchArguments: undefined,
  permissions: undefined,
  command: undefined,
  readyUrl: undefined,
};
const EMPTY_DECLARED: ResolvedTarget['declaredApp'] = {
  url: undefined,
  bundleId: undefined,
  appPath: undefined,
  linkBase: undefined,
  identity: undefined,
  environment: undefined,
  launchArguments: undefined,
  permissions: undefined,
  command: undefined,
  readyUrl: undefined,
};
const target: ResolvedTarget = {
  name: 'web',
  index: 0,
  platform: 'web',
  engine: undefined,
  app: EMPTY_APP,
  declaredApp: EMPTY_DECLARED,
  trace: { mode: 'off', source: 'default' },
  video: { mode: 'off', source: 'default' },
  fullyParallel: false,
  fixtureScopes: new Map(),
};

function makeTest(
  file: string,
  title: string,
  declarationIndex: number,
  overrides: Partial<CollectedTest> = {},
): CollectedTest {
  return {
    kind: 'test',
    title,
    titlePath: [title],
    names: [],
    declarationIndex,
    options: {},
    sessions: [],
    tags: [],
    fn: () => undefined,
    fixtures: [],
    group: undefined,
    mode: 'normal',
    source: undefined,
    file,
    id: `test::${file}::${title}`,
    serialRoot: undefined,
    parallel: { declared: false, ordered: undefined, suiteHooks: false },
    serialId: undefined,
    selected: true,
    focused: false,
    ...overrides,
  };
}

const defaultOptions: ResolvedTestOptions = {
  timeout: 30_000,
  retries: 0,
  platforms: undefined,
  session: undefined,
  agents: ['default'],
  agentContext: undefined,
  skipReason: undefined,
  expectedFailure: undefined,
  serial: false,
  trace: undefined,
  video: undefined,
};

function makePair(test: CollectedTest, overrides: Partial<TestTargetPair> = {}): TestTargetPair {
  return { test, target, agent: 'default', repeat: 0, options: defaultOptions, disposition: 'run', skip: undefined, ...overrides };
}

function makeFile(file: string, tests: CollectedTest[]): CollectedFile {
  return {
    file,
    absolutePath: `/project/${file}`,
    registration: { tests: [], hooks: [] },
    tests,
    selected: true,
  };
}

describe('buildWorkPlans', () => {
  it('groups runnable ordinary pairs into per-file units and setups into single-pair units', () => {
    const setup = makeTest('tests/auth.setup.e2e.ts', 'login', 0, {
      kind: 'setup',
      sessions: ['user'],
    });
    const a1 = makeTest('tests/a.e2e.ts', 'a one', 0);
    const a2 = makeTest('tests/a.e2e.ts', 'a two', 1);
    const b1 = makeTest('tests/b.e2e.ts', 'b one', 0);
    const skipped = makeTest('tests/b.e2e.ts', 'b skipped', 1);

    const pairs = [
      makePair(setup),
      makePair(a1),
      makePair(a2),
      makePair(b1),
      makePair(skipped, {
        disposition: 'skip',
        skip: { cause: 'explicit', reason: 'skipped' },
      }),
    ];
    const selection: Selection = { pairs, perTarget: [{ target, pairs }] };
    const collection: Collection = {
      files: [
        makeFile('tests/a.e2e.ts', [a1, a2]),
        makeFile('tests/auth.setup.e2e.ts', [setup]),
        makeFile('tests/b.e2e.ts', [b1, skipped]),
      ],
      tests: [a1, a2, setup, b1, skipped],
      nearMisses: [],
      unmatchedPositionals: [],
      uncollected: [],
    };

    const plans = buildWorkPlans(selection, collection, '/project', 4);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.setupUnits).toHaveLength(1);
    expect(plan.setupUnits[0]!.kind).toBe('setup');
    expect(plan.setupUnits[0]!.pairs.map((pair) => pair.test.title)).toEqual(['login']);
    expect(plan.fileUnits.map((unit) => unit.file)).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
    expect(plan.fileUnits[0]!.pairs.map((pair) => pair.test.title)).toEqual(['a one', 'a two']);
    expect(plan.fileUnits[1]!.pairs.map((pair) => pair.test.title)).toEqual(['b one']);
    expect(plan.immediate.map((pair) => pair.test.title)).toEqual(['b skipped']);
  });

  it('emits no file unit when a file has no runnable pairs', () => {
    const only = makeTest('tests/a.e2e.ts', 'filtered', 0);
    const pairs = [
      makePair(only, { disposition: 'filtered', skip: { cause: 'filtered', reason: 'tags' } }),
    ];
    const selection: Selection = { pairs, perTarget: [{ target, pairs }] };
    const collection: Collection = {
      files: [makeFile('tests/a.e2e.ts', [only])],
      tests: [only],
      nearMisses: [],
      unmatchedPositionals: [],
      uncollected: [],
    };
    const plans = buildWorkPlans(selection, collection, '/project', 4);
    expect(plans[0]!.fileUnits).toHaveLength(0);
    expect(plans[0]!.immediate).toHaveLength(1);
  });
});

describe('buildWorkPlans with parallel scopes', () => {
  const FILE = 'tests/a.e2e.ts';
  const inParallel = { declared: true, ordered: undefined, suiteHooks: false };

  /** The units of one file holding `tests`, each unit as the titles it runs. */
  function unitsOf(tests: readonly CollectedTest[], options: { workers?: number; target?: ResolvedTarget; pairs?: TestTargetPair[] } = {}): string[][] {
    const on = options.target ?? target;
    const pairs = options.pairs ?? tests.map((test) => makePair(test, { target: on }));
    const collection: Collection = { files: [makeFile(FILE, [...tests])], tests: [...tests], nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target: on, pairs }] }, collection, '/project', options.workers ?? 4);
    return plan!.fileUnits.map((unit) => unit.pairs.map((pair) => pair.test.title));
  }

  /** The plan of one file holding `tests`, each run one time. */
  function planOf(tests: CollectedTest[]): TargetWorkPlan {
    const pairs = tests.map((test) => makePair(test));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    return buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4)[0]!;
  }

  it('gives each test of a parallel scope its own unit and keeps the rest of the file in one', () => {
    const tests = [
      makeTest(FILE, 'plain 1', 0),
      makeTest(FILE, 'parallel 1', 1, { parallel: inParallel }),
      makeTest(FILE, 'plain 2', 2),
      makeTest(FILE, 'parallel 2', 3, { parallel: inParallel }),
    ];
    expect(unitsOf(tests)).toEqual([['plain 1', 'plain 2'], ['parallel 1'], ['parallel 2']]);
  });

  it('gives every unit of a file its own id and its share of the pairs, the first the id a whole file has', () => {
    const tests = [makeTest(FILE, 'plain', 0), makeTest(FILE, 'parallel 1', 1, { parallel: inParallel }), makeTest(FILE, 'parallel 2', 2, { parallel: inParallel })];
    const pairs = tests.map((test) => makePair(test));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4);
    expect(plan!.fileUnits.map((unit) => unit.id)).toEqual([`file::web::${FILE}`, `file::web::${FILE}::1`, `file::web::${FILE}::2`]);
    expect(plan!.fileUnits.map((unit) => unit.share)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it('splits every file of a fullyParallel target, and no file of another', () => {
    const tests = [makeTest(FILE, 'one', 0), makeTest(FILE, 'two', 1)];
    expect(unitsOf(tests, { target: { ...target, fullyParallel: true } })).toEqual([['one'], ['two']]);
    expect(unitsOf(tests)).toEqual([['one', 'two']]);
  });

  it('keeps a file with parallel: false whole under fullyParallel, every agent and repeat of it in the one unit', () => {
    const whole = { declared: false, ordered: 'file', suiteHooks: false };
    const tests = [makeTest(FILE, 'one', 0, { parallel: whole }), makeTest(FILE, 'two', 1, { parallel: whole })];
    const on = { ...target, fullyParallel: true };
    expect(unitsOf(tests, { target: on })).toEqual([['one', 'two']]);
    const pairs = tests.flatMap((test) => [0, 1].map((repeat) => makePair(test, { target: on, repeat })));
    expect(unitsOf(tests, { target: on, pairs })).toEqual([['one', 'one', 'two', 'two']]);
  });

  it('keeps a serial group and a parallel: false group in a parallel scope as one unit each', () => {
    const serial = { declared: true, ordered: 'group-0', suiteHooks: false };
    const ordered = { declared: true, ordered: 'group-1', suiteHooks: false };
    const tests = [
      makeTest(FILE, 'step 1', 0, { parallel: serial }),
      makeTest(FILE, 'alone', 1, { parallel: inParallel }),
      makeTest(FILE, 'step 2', 2, { parallel: serial }),
      makeTest(FILE, 'ordered 1', 3, { parallel: ordered }),
      makeTest(FILE, 'ordered 2', 4, { parallel: ordered }),
    ];
    expect(unitsOf(tests)).toEqual([['step 1', 'step 2'], ['alone'], ['ordered 1', 'ordered 2']]);
  });

  it('keeps every repeat of an ordered scope in the scope\'s one unit, a test\'s repeats one after another', () => {
    const serial = { declared: true, ordered: 'group-0', suiteHooks: false };
    const tests = [makeTest(FILE, 'step 1', 0, { parallel: serial }), makeTest(FILE, 'step 2', 1, { parallel: serial })];
    const pairs = [0, 1].flatMap((repeat) => tests.map((test) => makePair(test, { repeat })));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4);
    expect(plan!.fileUnits.map((unit) => unit.pairs.map((pair) => `${pair.test.title}@${pair.repeat}`))).toEqual([
      ['step 1@0', 'step 1@1', 'step 2@0', 'step 2@1'],
    ]);
  });

  it('keeps the repeats of a parallel test in one unit, so the first can record what the rest replay', () => {
    const tests = [makeTest(FILE, 'one', 0, { parallel: inParallel }), makeTest(FILE, 'two', 1, { parallel: inParallel })];
    const pairs = tests.flatMap((test) => ['fast', 'smart'].flatMap((agent) => [0, 1].map((repeat) => makePair(test, { agent, repeat }))));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4);
    expect(plan!.fileUnits.map((unit) => unit.pairs.map((pair) => `${pair.test.title}@${pair.agent}@${pair.repeat}`))).toEqual([
      ['one@fast@0', 'one@fast@1'],
      ['one@smart@0', 'one@smart@1'],
      ['two@fast@0', 'two@fast@1'],
      ['two@smart@0', 'two@smart@1'],
    ]);
  });

  it('marks the units of a file that was cut, and not the unit of a whole file', () => {
    const cut = planOf([makeTest(FILE, 'one', 0, { parallel: inParallel }), makeTest(FILE, 'two', 1, { parallel: inParallel })]);
    expect(cut.fileUnits.map((unit) => unit.split)).toEqual([true, true]);
    const whole = planOf([makeTest(FILE, 'one', 0), makeTest(FILE, 'two', 1)]);
    expect(whole.fileUnits.map((unit) => unit.split)).toEqual([false]);
  });

  it('cuts a file into more units than a function call takes arguments', () => {
    const tests = Array.from({ length: 200_000 }, (_, index) => makeTest(FILE, `test ${index}`, index, { parallel: inParallel }));
    expect(planOf(tests).fileUnits).toHaveLength(200_000);
  });

  it('shares units between parallel tests with suite hooks, one unit for each worker', () => {
    const hooked = { declared: true, ordered: undefined, suiteHooks: true };
    const tests = Array.from({ length: 5 }, (_, index) => makeTest(FILE, `hooked ${index}`, index, { parallel: hooked }));
    expect(unitsOf(tests, { workers: 2 })).toEqual([['hooked 0', 'hooked 1', 'hooked 2'], ['hooked 3', 'hooked 4']]);
    expect(unitsOf(tests, { workers: 4 })).toEqual([['hooked 0', 'hooked 1'], ['hooked 2'], ['hooked 3'], ['hooked 4']]);
    expect(unitsOf(tests, { workers: 8 })).toEqual(tests.map((test) => [test.title]));
  });

  it('never shares a unit between the agents a hooked test or an ordered scope runs as', () => {
    const hooked = { declared: true, ordered: undefined, suiteHooks: true };
    const serial = { declared: true, ordered: 'group-0', suiteHooks: false };
    const tests = [
      makeTest(FILE, 'hooked 1', 0, { parallel: hooked }),
      makeTest(FILE, 'hooked 2', 1, { parallel: hooked }),
      makeTest(FILE, 'step 1', 2, { parallel: serial }),
      makeTest(FILE, 'step 2', 3, { parallel: serial }),
    ];
    const pairs = tests.flatMap((test) => ['fast', 'smart'].map((agent) => makePair(test, { agent })));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 2);
    expect(plan!.fileUnits.map((unit) => unit.pairs.map((pair) => `${pair.test.title}@${pair.agent}`))).toEqual([
      ['hooked 1@fast'],
      ['hooked 1@smart'],
      ['hooked 2@fast'],
      ['hooked 2@smart'],
      ['step 1@fast', 'step 2@fast'],
      ['step 1@smart', 'step 2@smart'],
    ]);
  });

  it('cuts the tests with suite hooks into units by test, every repeat of a test in the unit of its test', () => {
    const hooked = { declared: true, ordered: undefined, suiteHooks: true };
    const tests = [makeTest(FILE, 'a', 0, { parallel: hooked }), makeTest(FILE, 'b', 1, { parallel: hooked })];
    const pairs = tests.flatMap((test) => [0, 1].map((repeat) => makePair(test, { repeat })));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 2);
    expect(plan!.fileUnits.map((unit) => unit.pairs.map((pair) => `${pair.test.title}@${pair.repeat}`))).toEqual([['a@0', 'a@1'], ['b@0', 'b@1']]);
    const [single] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 1);
    expect(single!.fileUnits.map((unit) => unit.pairs.map((pair) => `${pair.test.title}@${pair.repeat}`))).toEqual([['a@0', 'a@1', 'b@0', 'b@1']]);
  });

  it('cuts the files again when prepare reports fewer workers', () => {
    const hooked = { declared: true, ordered: undefined, suiteHooks: true };
    const other = 'tests/b.e2e.ts';
    const tests = [
      ...Array.from({ length: 4 }, (_, index) => makeTest(FILE, `hooked ${index}`, index, { parallel: hooked })),
      makeTest(other, 'one', 0, { parallel: inParallel }),
      makeTest(other, 'two', 1, { parallel: inParallel }),
    ];
    const pairs = tests.map((test) => makePair(test));
    const collection: Collection = {
      files: [makeFile(FILE, tests.slice(0, 4)), makeFile(other, tests.slice(4))],
      tests,
      nearMisses: [],
      unmatchedPositionals: [],
      uncollected: [],
    };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4);
    expect(plan!.fileUnits).toHaveLength(6);
    const titles = (capped: TargetWorkPlan): string[][] => capped.fileUnits.map((unit) => unit.pairs.map((pair) => pair.test.title));
    expect(titles(withWorkerCap(plan!, 2))).toEqual([['hooked 0', 'hooked 1'], ['hooked 2', 'hooked 3'], ['one'], ['two']]);
    const one = withWorkerCap(plan!, 1);
    expect(titles(one)).toEqual([['hooked 0', 'hooked 1', 'hooked 2', 'hooked 3'], ['one'], ['two']]);
    expect(one.workers).toBe(1);
    expect(one.fileUnits.map((unit) => [unit.id, unit.share])).toEqual([[`file::web::${FILE}`, 1], [`file::web::${other}`, 0.5], [`file::web::${other}::1`, 0.5]]);
  });

  it('ranks a unit that holds part of a file by that part of the time the file took', () => {
    const other = 'tests/b.e2e.ts';
    const tests = [
      ...Array.from({ length: 3 }, (_, index) => makeTest(FILE, `part ${index}`, index, { parallel: inParallel })),
      makeTest(other, 'whole', 0),
    ];
    const pairs = tests.map((test) => makePair(test));
    const collection: Collection = {
      files: [makeFile(FILE, tests.slice(0, 3)), makeFile(other, tests.slice(3))],
      tests,
      nearMisses: [],
      unmatchedPositionals: [],
      uncollected: [],
    };
    const plans = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4);
    const durations = new Map([[FILE, 9_000], [other, 5_000]]);
    const [ordered] = orderWorkPlans(plans, { relevanceOf: () => 0, durationOf: (_, file) => durations.get(file) });
    expect(ordered!.fileUnits.map((unit) => unit.pairs[0]!.test.title)).toEqual(['whole', 'part 0', 'part 1', 'part 2']);
  });

  it('keeps the file of tests registered in memory whole, since nothing can import it again', () => {
    const tests = [makeTest(FILE, 'one', 0, { parallel: inParallel }), makeTest(FILE, 'two', 1, { parallel: inParallel })];
    const pairs = tests.map((test) => makePair(test));
    const collection: Collection = { files: [makeFile(FILE, tests)], tests, nearMisses: [], unmatchedPositionals: [], uncollected: [] };
    const [plan] = buildWorkPlans({ pairs, perTarget: [{ target, pairs }] }, collection, '/project', 4, FILE);
    expect(plan!.fileUnits.map((unit) => unit.pairs.map((pair) => pair.test.title))).toEqual([['one', 'two']]);
  });

  it('cuts a file for one worker as for many, but for the tests with suite hooks, which share one unit', () => {
    const hooked = { declared: true, ordered: undefined, suiteHooks: true };
    const tests = [
      makeTest(FILE, 'plain', 0),
      makeTest(FILE, 'one', 1, { parallel: inParallel }),
      makeTest(FILE, 'two', 2, { parallel: inParallel }),
      makeTest(FILE, 'hooked 1', 3, { parallel: hooked }),
      makeTest(FILE, 'hooked 2', 4, { parallel: hooked }),
    ];
    const cut = [['plain'], ['one'], ['two'], ['hooked 1', 'hooked 2']];
    expect(unitsOf(tests, { workers: 1 })).toEqual(cut);
    const single: ResolvedTarget = { ...target, engine: protocolEngine(defineEngine({ name: 'pool', version: '1.0.0', spiVersion: 1, workers: 1 })) };
    expect(unitsOf(tests, { target: single })).toEqual(cut);
  });
});

describe('orderWorkPlans', () => {
  /** The id of test `index` of `file`, as `plansFor` makes them. */
  const idOf = (file: string, index = 0): string => `test::${file}::${file}#${index}`;

  /**
   * Work plans for the targets named by the keys of `files`, in that order,
   * each running the files it maps to, `testsPerFile` tests of each.
   */
  function plansFor(files: Readonly<Record<string, readonly string[]>>, testsPerFile = 1): TargetWorkPlan[] {
    const all = [...new Set(Object.values(files).flat())];
    const tests = new Map(all.map((file) => [file, Array.from({ length: testsPerFile }, (_, index) => makeTest(file, `${file}#${index}`, index))]));
    const perTarget = Object.entries(files).map(([name, names], index) => {
      const named: ResolvedTarget = { ...target, name, index };
      return { target: named, pairs: names.flatMap((file) => tests.get(file)!.map((test) => makePair(test, { target: named }))) };
    });
    const collection: Collection = {
      files: all.map((file) => makeFile(file, tests.get(file)!)),
      tests: [...tests.values()].flat(),
      nearMisses: [],
      unmatchedPositionals: [],
      uncollected: [],
    };
    return buildWorkPlans({ pairs: perTarget.flatMap((entry) => entry.pairs), perTarget }, collection, '/project', 4);
  }

  /** The files of each plan in dispatch order, keyed by target. */
  const dispatched = (plans: readonly TargetWorkPlan[]): [string, string[]][] => plans.map((plan) => [plan.target.name, plan.fileUnits.map((unit) => unit.file)]);

  const FILES = ['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts', 'tests/d.e2e.ts', 'tests/e.e2e.ts'];
  const none = (): number => 0;
  const untimed = (): undefined => undefined;

  it('dispatches the files the previous run spent longest in first, untimed ones before them, ties in collection order', () => {
    const previous = new Map([
      ['tests/a.e2e.ts', 100],
      ['tests/b.e2e.ts', 900],
      ['tests/d.e2e.ts', 100],
    ]);
    const plans = orderWorkPlans(plansFor({ web: FILES }), {
      relevanceOf: none,
      durationOf: (targetName, file) => (targetName === 'web' ? previous.get(file) : undefined),
    });
    expect(dispatched(plans)).toEqual([['web', ['tests/c.e2e.ts', 'tests/e.e2e.ts', 'tests/b.e2e.ts', 'tests/a.e2e.ts', 'tests/d.e2e.ts']]]);
  });

  it('keeps collection order when no file has a score or a timing', () => {
    const plans = plansFor({ web: FILES });
    expect(dispatched(orderWorkPlans(plans, { relevanceOf: none, durationOf: untimed }))).toEqual([['web', FILES]]);
  });

  it('starts the likeliest band first whatever the timings say, the longest file first inside a band, and an untimed file before the timed ones', () => {
    const files = ['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts', 'tests/d.e2e.ts', 'tests/e.e2e.ts', 'tests/f.e2e.ts'];
    const scores: Record<string, number> = {
      [idOf('tests/a.e2e.ts')]: 0.9,
      [idOf('tests/b.e2e.ts')]: 0.8,
      // Each edge opens its own band: 0.5 is in the one above 0.49, and 0.24 is under the last.
      [idOf('tests/c.e2e.ts')]: 0.5,
      [idOf('tests/d.e2e.ts')]: 0.49,
      [idOf('tests/e.e2e.ts')]: 0.24,
    };
    const durations: Record<string, number> = { 'tests/a.e2e.ts': 100, 'tests/b.e2e.ts': 900, 'tests/c.e2e.ts': 10, 'tests/d.e2e.ts': 5000, 'tests/e.e2e.ts': 700 };
    const plans = orderWorkPlans(plansFor({ web: files }), {
      relevanceOf: (testId) => scores[testId] ?? 0,
      durationOf: (_targetName, file) => durations[file],
    });
    // d ran longest and is not first: its band is under c's. f has no timing, so it is ahead of e in the last band.
    expect(dispatched(plans)).toEqual([['web', ['tests/b.e2e.ts', 'tests/a.e2e.ts', 'tests/c.e2e.ts', 'tests/d.e2e.ts', 'tests/f.e2e.ts', 'tests/e.e2e.ts']]]);
  });

  it('ranks a file by the likeliest of its tests, and a test no one scored as 0', () => {
    const files = ['tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts'];
    const scores: Record<string, number> = {
      [idOf('tests/a.e2e.ts', 0)]: 0.3,
      [idOf('tests/a.e2e.ts', 1)]: 0.4,
      [idOf('tests/b.e2e.ts', 1)]: 0.8,
    };
    const plans = orderWorkPlans(plansFor({ web: files }, 2), { relevanceOf: (testId) => scores[testId] ?? 0, durationOf: untimed });
    expect(dispatched(plans)).toEqual([['web', ['tests/b.e2e.ts', 'tests/a.e2e.ts', 'tests/c.e2e.ts']]]);
  });

  it('ranks a file by its tests on every repeat', () => {
    const [plan] = plansFor({ web: ['tests/a.e2e.ts', 'tests/b.e2e.ts'] });
    const [unit] = plan!.fileUnits;
    const repeated: TargetWorkPlan = { ...plan!, fileUnits: [unit!, { ...plan!.fileUnits[1]!, pairs: [0, 1, 2].map((repeat) => ({ ...plan!.fileUnits[1]!.pairs[0]!, repeat })) }] };
    const ordered = orderWorkPlans([repeated], { relevanceOf: (testId) => (testId === idOf('tests/b.e2e.ts') ? 0.6 : 0), durationOf: untimed });
    expect(dispatched(ordered)).toEqual([['web', ['tests/b.e2e.ts', 'tests/a.e2e.ts']]]);
  });

  it('starts the target with the likeliest file first, ties keeping config order, and orders the files inside each', () => {
    const scores: Record<string, number> = {
      [idOf('tests/c.e2e.ts')]: 0.3,
      [idOf('tests/d.e2e.ts')]: 0.9,
      [idOf('tests/g.e2e.ts')]: 0.3,
    };
    const plans = orderWorkPlans(
      plansFor({
        web: ['tests/a.e2e.ts', 'tests/b.e2e.ts'],
        ios: ['tests/c.e2e.ts', 'tests/e.e2e.ts'],
        android: ['tests/f.e2e.ts', 'tests/d.e2e.ts'],
        tablet: ['tests/g.e2e.ts', 'tests/h.e2e.ts'],
      }),
      { relevanceOf: (testId) => scores[testId] ?? 0, durationOf: untimed },
    );
    expect(dispatched(plans)).toEqual([
      ['android', ['tests/d.e2e.ts', 'tests/f.e2e.ts']],
      ['ios', ['tests/c.e2e.ts', 'tests/e.e2e.ts']],
      ['tablet', ['tests/g.e2e.ts', 'tests/h.e2e.ts']],
      ['web', ['tests/a.e2e.ts', 'tests/b.e2e.ts']],
    ]);
  });

  it('leaves the plans in config order when nothing is scored, a target with no file to run keeping its place', () => {
    const plans = plansFor({ web: ['tests/a.e2e.ts'], ios: [], android: ['tests/b.e2e.ts'] });
    expect(dispatched(orderWorkPlans(plans, { relevanceOf: none, durationOf: untimed })).map(([name]) => name)).toEqual(['web', 'ios', 'android']);
  });

  it('keeps each plan\'s setup units, immediate pairs, and everything else it carries', () => {
    const [plan] = plansFor({ web: ['tests/a.e2e.ts', 'tests/b.e2e.ts'] });
    const withExtras: TargetWorkPlan = { ...plan!, workers: 2, env: { A: '1' } };
    const [ordered] = orderWorkPlans([withExtras], { relevanceOf: (testId) => (testId === idOf('tests/b.e2e.ts') ? 1 : 0), durationOf: untimed });
    expect(ordered).toMatchObject({ target: withExtras.target, setupUnits: withExtras.setupUnits, immediate: withExtras.immediate, workers: 2, env: { A: '1' } });
    expect(ordered!.fileUnits.map((unit) => unit.file)).toEqual(['tests/b.e2e.ts', 'tests/a.e2e.ts']);
  });
});

describe('result helpers', () => {
  it('nonRunResult marks skip pairs selected and filtered pairs unselected', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const skipPair = makePair(test, {
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'skipped' },
    });
    const filteredPair = makePair(test, { disposition: 'filtered', skip: undefined });
    expect(nonRunResult(skipPair)).toMatchObject({ status: 'skipped', selected: true });
    expect(nonRunResult(filteredPair)).toMatchObject({
      status: 'skipped',
      selected: false,
      skip: { cause: 'filtered' },
    });
  });

  it('unstartedResult keeps the pair identity and provided skip info', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const record = unstartedResult(makePair(test), {
      cause: 'infrastructure-unavailable',
      reason: 'worker crashed',
    });
    expect(record.status).toBe('skipped');
    expect(record.selected).toBe(true);
    expect(record.skip?.reason).toBe('worker crashed');
  });

  it('interruptedInPhase names the limit that stopped the run, and only the phase for a plain interrupt', () => {
    const interrupt = (reason?: unknown): AbortSignal => {
      const controller = new AbortController();
      controller.abort(reason);
      return controller.signal;
    };
    expect(interruptedInPhase(interrupt(), 'body')).toBe('run interrupted in phase body');
    expect(interruptedInPhase(interrupt(timeLimitSkip({ ms: 2000, source: '--max-duration' })), 'body')).toBe(
      'run interrupted in phase body: run stopped at its time limit of 2000 ms (--max-duration)',
    );
    expect(interruptedInPhase(interrupt(failureLimitSkip(1, 1)), 'body')).toBe(
      'run interrupted in phase body: run stopped after 1 failure (--max-failures 1)',
    );
  });
});

describe('wire protocol', () => {
  it('round-trips a result record, replacing the target', () => {
    const test = makeTest('tests/a.e2e.ts', 'x', 0);
    const record: ResultRecord = {
      test,
      target,
      agent: 'default',
      repeat: 0,
      status: 'passed',
      selected: true,
      attempts: [],
    };
    const wire = JSON.parse(JSON.stringify(encodeResult(record)));
    expect(wire.target).toBeUndefined();
    const decoded = decodeResult(wire, target);
    expect(decoded.target).toBe(target);
    expect(decoded.test.id).toBe(test.id);
    expect(decoded.status).toBe('passed');
  });

  it('carries no test function across the wire', () => {
    const record = nonRunResult({
      test: makeTest('tests/a.e2e.ts', 'x', 0),
      target,
      agent: 'default',
      repeat: 0,
      options: defaultOptions,
      disposition: 'skip',
      skip: { cause: 'explicit', reason: 'skipped' },
    });
    expect('fn' in record.test).toBe(false);
    expect(JSON.parse(JSON.stringify(encodeResult(record))).test.id).toBe(record.test.id);
  });
});
