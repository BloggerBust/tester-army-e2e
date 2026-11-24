/** Fixtures set up on demand: what a test, its hooks, and their fixtures name, the `auto` ones, and the rules that fail at collection. */

import { describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { hookLog, LOG_MODULE } from '../helpers/hook-log.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

/** A fixture that logs its setup and teardown and hands its own name over. */
const LOGGED = `const logged = (name: string) => async ({}: object, use: (value: string) => Promise<void>) => {
  log('setup:' + name);
  await use(name);
  log('teardown:' + name);
};
`;

describe('on-demand fixtures', () => {
  it(
    'sets up what a test and its hooks name, what those fixtures name, and the auto fixtures, and nothing else',
    async () => {
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';
${LOGGED}
let starts = 0;
export const test = base
  .extend<{ idle: string; watch: string; cleanup: string }, { database: number; unused: string; install: string }>({
    idle: logged('idle'),
    watch: [logged('watch'), { auto: true }],
    cleanup: logged('cleanup'),
    database: [async ({ platform }, use) => {
      starts += 1;
      log('setup:database:' + platform + ':' + starts);
      await use(starts);
      log('teardown:database');
    }, { scope: 'worker' }],
    unused: [logged('unused'), { scope: 'worker' }],
    install: [logged('install'), { scope: 'worker', auto: true }],
  })
  .extend<{ page: string; account: string }>({
    // Written before the fixture it names: order follows the names, not the object.
    page: async ({ account, database }, use) => {
      log('setup:page:' + account + ':' + database);
      await use('page');
      log('teardown:page');
    },
    account: logged('account'),
  });
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('named', () => {
  test.afterEach(({ cleanup }) => log('afterEach:' + cleanup));
  test('names page', ({ page }) => log('body:' + page));
  test('names the database', function ({ database: db = 0 }) { log('body:database:' + db); });
});

test('names nothing', () => log('body:nothing'));
test('names a built-in', async ({ app, platform: p }) => log('body:' + p + ':' + typeof app.open));
`;
      const log = hookLog('on-demand');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/a.e2e.ts': file },
        { config: engineConfig(createFakeEngine({ fixtures: true }).engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        for (const title of ['names page', 'names the database', 'names nothing', 'names a built-in']) expect(resultByTitle(outcome, title).status).toBe('passed');
        expect(log.lines()).toEqual([
          // `cleanup`, which only the afterEach names, is set up before the body, not on the cleanup budget.
          'setup:watch',
          'setup:cleanup',
          'setup:database:fake:1',
          'setup:install',
          'setup:account',
          'setup:page:account:1',
          'body:page',
          'afterEach:cleanup',
          'teardown:page',
          'teardown:account',
          'teardown:cleanup',
          'teardown:watch',
          // The worker's database and install stay; the test fixtures nobody names here do not come back.
          'setup:watch',
          'setup:cleanup',
          'body:database:1',
          'afterEach:cleanup',
          'teardown:cleanup',
          'teardown:watch',
          'setup:watch',
          'body:nothing',
          'teardown:watch',
          'setup:watch',
          'body:fake:function',
          'teardown:watch',
          'teardown:install',
          'teardown:database',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'skips an afterEach hook that names a fixture whose setup failed, and still runs the others',
    async () => {
      const file = `import { test as base } from 'e2e';
import { log } from './log.ts';
${LOGGED}
const test = base.extend<{ ready: string; broken: string }>({
  ready: logged('ready'),
  broken: async ({ ready }, use) => {
    log('setup:broken:' + ready);
    throw new Error('seed failed');
  },
});

test.afterEach(({ broken }) => log('afterEach:broken:' + broken));
test.afterEach(({ ready }) => log('afterEach:ready:' + ready));
test.afterEach(() => log('afterEach:plain'));
test('never starts', ({ broken }) => log('body:' + broken));
`;
      const log = hookLog('on-demand-failed-setup');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/a.e2e.ts': file },
        { config: engineConfig(createFakeEngine().engine, { retries: 0 }) },
      );
      try {
        assertValidReport(outcome.report);
        const result = resultByTitle(outcome, 'never starts');
        expect(result.status).toBe('failed');
        expect(result.attempts[0]!.error).toMatchObject({ phase: 'beforeEach', message: expect.stringContaining('seed failed') });
        expect(result.attempts[0]!.secondaryErrors).toEqual([]);
        expect(log.lines()).toEqual(['setup:ready', 'setup:broken:ready', 'afterEach:plain', 'afterEach:ready:ready', 'teardown:ready']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'opens no engine attempt for a suite hook or a worker teardown that names no engine fixture',
    async () => {
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';

type Gadget = { poke(what: string): Promise<string> };
export const test = base.extend<{}, { gadget: Gadget }>().extend<{}, { database: string; keeper: string }>({
  database: [async ({ platform }, use) => {
    log('setup:database:' + platform);
    await use('db');
    log('teardown:database');
  }, { scope: 'worker' }],
  keeper: [async ({ gadget }, use) => {
    log('setup:keeper:' + await gadget.poke('keeper'));
    await use('kept');
    log('teardown:keeper:' + await gadget.poke('keeper-teardown'));
  }, { scope: 'worker' }],
});
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('reads the platform', () => {
  test.beforeAll(({ platform, database }) => log('beforeAll:' + platform + ':' + database));
  test.afterAll(() => log('afterAll:plain'));
  test('one', async ({ gadget }) => log('body:' + await gadget.poke('one')));
});

test.describe('drives the device', () => {
  test.beforeAll(({ platform }) => log('beforeAll:first:' + platform));
  test.beforeAll(async ({ keeper }) => log('beforeAll:' + keeper));
  test.afterAll(({ database }) => log('afterAll:' + database));
  test('two', () => log('body:two'));
});
`;
      const log = hookLog('on-demand-suite-hooks');
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        expect(log.lines()).toEqual([
          'setup:database:fake',
          'beforeAll:fake:db',
          'body:poked one',
          'afterAll:plain',
          'beforeAll:first:fake',
          'setup:keeper:poked keeper',
          'beforeAll:kept',
          'body:two',
          'afterAll:db',
          'teardown:keeper:poked keeper-teardown',
          'teardown:database',
        ]);
        // Attempts: test one, the pass with the keeper hook, test two, and the
        // keeper's teardown. The hooks that read `platform` or the database,
        // and the database's teardown, open none.
        expect(fake.events).toEqual([
          'init',
          'startAttempt:0',
          'endAttempt:0',
          'startAttempt:1',
          'endAttempt:1',
          'startAttempt:2',
          'endAttempt:2',
          'startAttempt:3',
          'endAttempt:3',
          'dispose',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'sets up for each test.each and test.for row what the body names after its row',
    async () => {
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';
${LOGGED}
export const test = base.extend<{ page: string; idle: string }>({ page: logged('page'), idle: logged('idle') });
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.each([{ user: 'Ada' }, { user: 'Grace' }])('signs in as $user', ({ user }, { page }) => log('body:' + user + ':' + page));
test.each([[1, 2]])('adds %i and %i', (a, b, { platform }) => log('body:' + (a + b) + ':' + platform));
test.for([['x', 'y']])('pairs %s and %s', ([a, b]) => log('body:' + a + b));
`;
      const log = hookLog('on-demand-each');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/a.e2e.ts': file },
        { config: engineConfig(createFakeEngine({ fixtures: true }).engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
          ['signs in as Ada', 'passed'],
          ['signs in as Grace', 'passed'],
          ['adds 1 and 2', 'passed'],
          ['pairs x and y', 'passed'],
        ]);
        // `page` once per row that names it; `idle`, which no body names, never.
        expect(log.lines()).toEqual([
          'setup:page',
          'body:Ada:page',
          'teardown:page',
          'setup:page',
          'body:Grace:page',
          'teardown:page',
          'body:3:fake',
          'body:xy',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'keeps a file valid on a target where the tests that name another engine\'s fixture do not run',
    async () => {
      const file = `import { test as base } from 'e2e';
import { log } from './log.ts';

const test = base.extend<{ gadget: { poke(what: string): Promise<string> } }>();

test('gadget only', { platforms: ['fake'] }, async ({ gadget }) => log('body:' + await gadget.poke('only')));
test.skipIf(process.env.NEVER !== '1')('skipped', async ({ gadget }) => log('unreachable:' + gadget));
test.describe('gadget suite', { platforms: ['fake'] }, () => {
  test.beforeAll(({ platform }) => log('beforeAll:' + platform));
  test.beforeEach(async ({ gadget }) => log('beforeEach:' + await gadget.poke('each')));
  test('in the suite', () => log('body:suite'));
});
test('everywhere', ({ platform }) => log('body:' + platform));
`;
      const log = hookLog('on-demand-cross-target');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/a.e2e.ts': file },
        {
          config: {
            targets: [
              { name: 'plain', platform: 'plain', engine: createFakeEngine().engine, app: FAKE_APP },
              { name: 'fake', platform: 'fake', engine: createFakeEngine({ fixtures: true }).engine, app: FAKE_APP },
            ],
            workers: 1,
          },
        },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        expect(outcome.results.filter((result) => result.status !== 'passed' && result.status !== 'skipped').map((result) => result.test.title)).toEqual([]);
        expect(log.lines().toSorted()).toEqual([
          'beforeAll:fake',
          'beforeEach:poked each',
          'body:fake',
          'body:plain',
          'body:poked only',
          'body:suite',
        ]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});

describe('fixture rules fail at collection', () => {
  const SUPPORT = `import { test as base } from 'e2e';

export const use = async ({}: object, use: (value: string) => Promise<void>) => { await use('value'); };
export const test = base.extend<{ gadget: unknown; workspace: string }, { database: string }>({
  workspace: use,
  database: [use, { scope: 'worker' }],
});
`;

  /** Runs one test file that breaks a rule and returns the run's errors and whether the engine was ever started. */
  async function collect(files: Readonly<Record<string, string>>, isolation: 'attempt' | 'worker' = 'attempt') {
    const fake = createFakeEngine({ fixtures: true, isolation });
    const { outcome, project } = await runProject({ 'tests/support.ts': SUPPORT, ...files }, { config: engineConfig(fake.engine) });
    project.cleanup();
    assertValidReport(outcome.report);
    return { errors: outcome.report.run.errors.map(({ code, phase, message }) => ({ code, phase, message })), events: fake.events, exitCode: outcome.exitCode, results: outcome.results };
  }

  /**
   * One collection error that opens with the file and line of the code. The
   * line is checked through the CLI (`cli-run.test.ts`): in this process
   * vitest formats stacks itself, without the loader's source maps.
   */
  const collectionError = (message: string, file = 'tests/a.e2e.ts') => [
    { code: 'COLLECTION_ERROR', phase: 'collection', message: expect.stringMatching(new RegExp(`^${file.replaceAll('.', '\\.')}:\\d+: ${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)) },
  ];
  const IMPORT = `import { test, use } from './support.ts';\n`;

  it.each([
    [
      'a test body that takes the whole fixture object',
      `${IMPORT}test('ok', async ({ workspace }) => void workspace);\ntest('whole', async (fixtures) => void fixtures);\n`,
      'test "whole" must destructure its first parameter, as in ({ app, screen }) => {}; it takes "fixtures". e2e sets up only the fixtures a function names there',
    ],
    [
      'a hook with a rest property',
      `${IMPORT}\ntest.describe('group', () => {\n  test.beforeEach(async ({ app, ...rest }) => void [app, rest]);\n  test('ok', () => {});\n});\n`,
      'beforeEach hook takes the rest property "...rest" in its first parameter; list the fixtures it uses by name. e2e sets up only the fixtures a function names there',
    ],
    [
      'a skipped test that takes the whole fixture object',
      `${IMPORT}test('ok', () => {});\ntest.skip('later', async (fixtures) => void fixtures);\n`,
      'test "later" must destructure its first parameter, as in ({ app, screen }) => {}; it takes "fixtures". e2e sets up only the fixtures a function names there',
    ],
    [
      'a test.each body that takes the whole fixture object after its row',
      `${IMPORT}test.each([{ user: 'Ada' }, { user: 'Grace' }])('signs in as $user', async ({ user }, fixtures) => void [user, fixtures]);\n`,
      'test "signs in as Ada" must destructure parameter 2, where it takes the fixtures, as in ({ app, screen }) => {}; it takes "fixtures". e2e sets up only the fixtures a function names there',
    ],
    [
      'a test.for body that names a fixture the target does not have',
      `${IMPORT}test.for([[1, 2]])('pair %#', async ([a, b], { workspce }: { workspce: unknown }) => void [a, b, workspce]);\n`,
      'test "pair 0" names "workspce": target "fake" has no "workspce" fixture; available: agent, app, database, gadget, platform, request, screen, session, workspace (engine fake contributes gadget); did you mean "workspace"?',
    ],
    [
      'an unknown fixture name',
      `${IMPORT}test('typo', async ({ workspce }: { workspce: unknown }) => void workspce);\n`,
      'test "typo" names "workspce": target "fake" has no "workspce" fixture; available: agent, app, database, gadget, platform, request, screen, session, workspace (engine fake contributes gadget); did you mean "workspace"?',
    ],
    [
      "another runner's fixture",
      `${IMPORT}test.afterEach(async ({ page }: { page: unknown }) => void page);\ntest('ported', () => {});\n`,
      'afterEach hook names "page": target "fake" has no "page" fixture; available: agent, app, database, gadget, platform, request, screen, session, workspace (engine fake contributes gadget); there is no Playwright page: open the app with app.open() and find elements through screen; browser-only APIs are on the browser fixture of a Playwright target',
    ],
    [
      'a suite hook that names a test fixture',
      `${IMPORT}test.beforeAll(({ database }) => void database);\ntest.afterAll(({ app }: { app: unknown }) => void app);\ntest('one', () => {});\n`,
      'afterAll hook names "app", a test fixture on target "fake": beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()',
    ],
    [
      'a worker fixture that names a fixture the engine keeps per test',
      `${IMPORT}const extended = test.extend<{}, { keeper: string }>({\n  keeper: [async ({ gadget }, use) => { await use(String(gadget)); }, { scope: 'worker' }],\n});\nextended('one', ({ keeper }) => void keeper);\n`,
      'worker fixture "keeper" names "gadget", a test fixture on target "fake": beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()',
    ],
  ])('%s', async (_, source, message) => {
    const { errors, events, exitCode, results } = await collect({ 'tests/a.e2e.ts': source });
    expect(errors).toEqual(collectionError(message));
    // Nothing started: no engine init, no attempt, no result.
    expect(events).toEqual([]);
    expect(results).toEqual([]);
    expect(exitCode).toBe(2);
  }, 120_000);

  it('a fixture function, a cycle, and a worker fixture that names a test fixture, at the extend() call in the module that declares them', async () => {
    const declares = (definitions: string) => ({
      'tests/fixtures.ts': `import { test as base } from 'e2e';\n\nexport const test = base.extend<Record<string, string>, Record<string, never>>(${definitions} as never);\n`,
      'tests/a.e2e.ts': `import { test } from './fixtures.ts';\ntest('one', () => {});\n`,
    });
    const whole = await collect(declares(`{ workspace: async (fixtures: object, use: (value: string) => Promise<void>) => use(String(fixtures)) }`));
    expect(whole.errors).toEqual(collectionError('fixture "workspace" must destructure its first parameter, as in ({ app, screen }) => {}; it takes "fixtures". e2e sets up only the fixtures a function names there', 'tests/fixtures.ts'));
    const cycle = await collect(declares(`{\n  a: async ({ b }: { b: string }, use: (value: string) => Promise<void>) => use(b),\n  b: async ({ a }: { a: string }, use: (value: string) => Promise<void>) => use(a),\n}`));
    expect(cycle.errors).toEqual(collectionError('fixtures depend on each other in a cycle: "a" -> "b" -> "a". A fixture cannot name one that needs it', 'tests/fixtures.ts'));
    const scope = await collect(declares(`{\n  page: [async ({}: object, use: (value: string) => Promise<void>) => use('p'), { scope: 'test' }],\n  cache: [async ({ page }: { page: string }, use: (value: string) => Promise<void>) => use(page), { scope: 'worker' }],\n}`));
    expect(scope.errors).toEqual(collectionError('worker fixture "cache" names "page", a test fixture: beforeAll, afterAll, and worker fixtures see worker fixtures only, since a test fixture is set up for one test. Use it in beforeEach, or save the state it builds with test.setup()', 'tests/fixtures.ts'));
    for (const { events } of [whole, cycle, scope]) expect(events).toEqual([]);
  }, 120_000);

  it('accepts on a device-like engine what its scope allows there', async () => {
    const source = `${IMPORT}const extended = test.extend<{}, { keeper: string }>({\n  keeper: [async ({ gadget, app }, use) => { await use(typeof gadget + typeof app.open); }, { scope: 'worker' }],\n});\nextended.beforeAll(({ keeper, screen }) => void [keeper, screen]);\nextended('one', ({ keeper }) => void keeper);\n`;
    const { errors, results } = await collect({ 'tests/a.e2e.ts': source }, 'worker');
    expect(errors).toEqual([]);
    expect(results.map((result) => result.status)).toEqual(['passed']);
  }, 120_000);
});
