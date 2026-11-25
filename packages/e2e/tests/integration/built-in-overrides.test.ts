/** `test.extend()` fixtures named like a built-in extend it: user code gets the override, with the scope the override declares. */

import { describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { hookLog, LOG_MODULE } from '../helpers/hook-log.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

/** `test` with `gadget` extended: the override pokes the gadget, then hands over a wrapper that tags every poke. */
const SUPPORT = `import { test as base } from 'e2e';
import { log } from './log.ts';

type Gadget = { poke(what: string): Promise<string> };
export const test = base.extend<{ gadget: Gadget }>().extend({
  gadget: async ({ gadget, platform }, use) => {
    log('setup:gadget:' + await gadget.poke('override on ' + platform));
    await use({ poke: async (what: string) => 'wrapped ' + await gadget.poke(what) });
    log('teardown:gadget:' + await gadget.poke('teardown'));
  },
});
`;

/** `SUPPORT` with the override declared as a worker fixture. */
const WORKER_SUPPORT = `import { test as base } from 'e2e';
import { log } from './log.ts';

type Gadget = { poke(what: string): Promise<string> };
export const test = base.extend<{}, { gadget: Gadget }>().extend({
  gadget: [async ({ gadget, platform }, use) => {
    log('setup:gadget:' + await gadget.poke('override on ' + platform));
    await use({ poke: async (what: string) => 'wrapped ' + await gadget.poke(what) });
    log('teardown:gadget:' + await gadget.poke('teardown'));
  }, { scope: 'worker' }],
});
`;

describe('fixtures that extend a built-in', () => {
  it(
    'runs a test-scoped override for each test that names the built-in, and chains a second override on it',
    async () => {
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

const twice = test.extend({
  gadget: async ({ gadget }, use) => {
    log('setup:second');
    await use({ poke: async (what: string) => 'twice ' + await gadget.poke(what) });
    log('teardown:second');
  },
  app: async ({ app, gadget }, use) => {
    log('setup:app:' + typeof app.open + ':' + await gadget.poke('app'));
    await use(app);
  },
});

test.beforeEach(async ({ gadget }) => log('beforeEach:' + await gadget.poke('each')));
test('extended', async ({ gadget }) => log('body:' + await gadget.poke('one')));
test('names nothing', ({ platform }) => log('body:' + platform));
twice('chained', async ({ gadget, app }) => log('body:' + await gadget.poke('two') + ':' + typeof app.open));
`;
      const log = hookLog('override-test-scope');
      const fake = createFakeEngine({ fixtures: true });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': SUPPORT, 'tests/a.e2e.ts': file },
        { config: engineConfig(fake.engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        for (const title of ['extended', 'names nothing', 'chained']) expect(resultByTitle(outcome, title).status).toBe('passed');
        expect(log.lines()).toEqual([
          'setup:gadget:poked override on fake',
          'beforeEach:wrapped poked each',
          'body:wrapped poked one',
          'teardown:gadget:poked teardown',
          // The file-level beforeEach names the gadget, so the override runs for this test too.
          'setup:gadget:poked override on fake',
          'beforeEach:wrapped poked each',
          'body:fake',
          'teardown:gadget:poked teardown',
          'setup:gadget:poked override on fake',
          'setup:second',
          'setup:app:function:twice wrapped poked app',
          'beforeEach:twice wrapped poked each',
          'body:twice wrapped poked two:function',
          'teardown:second',
          'teardown:gadget:poked teardown',
        ]);
        // The engine's own fixture recorded every call as a step of the test that made it.
        const steps = resultByTitle(outcome, 'extended').attempts[0]!.steps.map((step) => `${step.api} ${step.label}`);
        expect(steps).toEqual(['gadget.poke override on fake', 'gadget.poke each', 'gadget.poke one', 'gadget.poke teardown']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'runs a worker-scoped override once per worker on an engine whose state outlives a test, for beforeAll too',
    async () => {
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.describe('device suite', () => {
  test.beforeAll(async ({ gadget }) => log('beforeAll:' + await gadget.poke('hook')));
  test.afterAll(({ platform }) => log('afterAll:' + platform));
  test('one', async ({ gadget }) => log('body:' + await gadget.poke('one')));
  test('two', async ({ gadget, app }) => log('body:' + await gadget.poke('two') + ':' + typeof app.open));
  test('names nothing', () => log('body:nothing'));
});
`;
      const log = hookLog('override-worker-scope');
      const fake = createFakeEngine({ fixtures: true, isolation: 'worker' });
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': WORKER_SUPPORT, 'tests/device.e2e.ts': file },
        { config: engineConfig(fake.engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        for (const title of ['one', 'two', 'names nothing']) expect(resultByTitle(outcome, title).status).toBe('passed');
        expect(log.lines()).toEqual([
          'setup:gadget:poked override on fake',
          'beforeAll:wrapped poked hook',
          'body:wrapped poked one',
          'body:wrapped poked two:function',
          'body:nothing',
          'afterAll:fake',
          'teardown:gadget:poked teardown',
        ]);
        // The override's calls land in whatever runs at the time: the test's own pokes are that test's steps.
        expect(resultByTitle(outcome, 'one').attempts[0]!.steps.map((step) => `${step.api} ${step.label}`)).toEqual(['gadget.poke one']);
        // Attempts: the beforeAll pass, three tests, and the override's teardown; the afterAll that reads `platform` opens none.
        expect(fake.events.filter((event) => event.startsWith('startAttempt'))).toHaveLength(5);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'lets a worker fixture name an app override declared with scope \'worker\' on an engine whose state outlives a test',
    async () => {
      const support = `import { test as base } from 'e2e';
import { log } from './log.ts';

export const test = base
  .extend({
    app: [async ({ app }, use) => {
      log('setup:app');
      await use(app);
    }, { scope: 'worker' }],
  })
  .extend<{}, { seeded: string }>({
    seeded: [async ({ app }, use) => {
      log('setup:seeded:' + typeof app.open);
      await use('seeded');
    }, { scope: 'worker' }],
  });
`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test.beforeAll(({ seeded }) => log('beforeAll:' + seeded));
test('one', ({ seeded }) => log('body:' + seeded));
`;
      const log = hookLog('override-worker-dependent');
      const { outcome, project } = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support, 'tests/device.e2e.ts': file },
        { config: engineConfig(createFakeEngine({ fixtures: true, isolation: 'worker' }).engine) },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        expect(resultByTitle(outcome, 'one').status).toBe('passed');
        expect(log.lines()).toEqual(['setup:app', 'setup:seeded:function', 'beforeAll:seeded', 'body:seeded']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'sets an override of an auto fixture up for every test only if it declares auto',
    async () => {
      const support = (options: string) => `import { test as base } from 'e2e';
import { log } from './log.ts';

export const test = base
  .extend<{ seed: string }>({
    seed: [async ({}, use) => {
      log('setup:seed');
      await use('seeded');
    }, { auto: true }],
  })
  .extend({
    seed: ${options},
  });
`;
      const override = `async ({ seed }, use) => {
      log('setup:override:' + seed);
      await use(seed + '!');
    }`;
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test('names nothing', () => log('body'));
test('names it', ({ seed }) => log('body:' + seed));
`;
      const log = hookLog('override-auto');
      const onDemand = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support(override), 'tests/a.e2e.ts': file },
        { config: engineConfig(createFakeEngine().engine) },
      );
      try {
        assertValidReport(onDemand.outcome.report);
        expect(onDemand.outcome.report.run.errors).toEqual([]);
        // The override is set up only for the test that names it, and the base through it.
        expect(log.lines()).toEqual(['body', 'setup:seed', 'setup:override:seeded', 'body:seeded!']);
      } finally {
        onDemand.project.cleanup();
      }
      const autoLog = hookLog('override-auto-declared');
      const auto = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': support(`[${override}, { auto: true }]`), 'tests/a.e2e.ts': file },
        { config: engineConfig(createFakeEngine().engine) },
      );
      try {
        assertValidReport(auto.outcome.report);
        expect(auto.outcome.report.run.errors).toEqual([]);
        expect(autoLog.lines()).toEqual(['setup:seed', 'setup:override:seeded', 'body', 'setup:seed', 'setup:override:seeded', 'body:seeded!']);
      } finally {
        auto.project.cleanup();
      }
    },
    120_000,
  );

  it.each([
    ['an auto fixture', `[async ({}, use) => { await use('mine'); }, { auto: true }]`],
    ['a fixture declared with scope \'test\'', `[async ({}, use) => { await use('mine'); }, { scope: 'test' }]`],
    ['a fixture that names app', `async ({ app }, use) => { void app; await use('mine'); }`],
  ])(
    'runs %s named like another target\'s worker fixture on a target without it',
    async (_kind, definition) => {
      const support = `import { test as base } from 'e2e';\n\nexport const test = base.extend({ gadget: ${definition} } as never);\n`;
      const file = `import { test } from './support.ts';\ntest('plain only', { platforms: ['plain'] }, async ({ gadget }) => { if (gadget !== 'mine') throw new Error(String(gadget)); });\n`;
      const { outcome, project } = await runProject(
        { 'tests/support.ts': support, 'tests/a.e2e.ts': file },
        {
          config: {
            targets: [
              { name: 'plain', platform: 'plain', engine: createFakeEngine().engine, app: FAKE_APP },
              { name: 'fake', platform: 'fake', engine: createFakeEngine({ fixtures: true, isolation: 'worker' }).engine, app: FAKE_APP },
            ],
          },
        },
      );
      try {
        assertValidReport(outcome.report);
        expect(outcome.report.run.errors).toEqual([]);
        expect(outcome.results.map((result) => `${result.target.name}: ${result.status}`).toSorted()).toEqual(['fake: skipped', 'plain: passed']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'fails nothing on a target that lacks the built-in until code there names it',
    async () => {
      const file = `import { test } from './support.ts';
import { log } from './log.ts';

test('everywhere', ({ platform }) => log('body:' + platform));
test('gadget only', { platforms: ['fake'] }, async ({ gadget }) => log('body:' + await gadget.poke('only')));
`;
      const targets = [
        { name: 'plain', platform: 'plain', engine: createFakeEngine().engine, app: FAKE_APP },
        { name: 'fake', platform: 'fake', engine: createFakeEngine({ fixtures: true }).engine, app: FAKE_APP },
      ];
      const log = hookLog('override-lacking-target');
      const ran = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': SUPPORT, 'tests/a.e2e.ts': file },
        { config: { targets, workers: 1 } },
      );
      try {
        assertValidReport(ran.outcome.report);
        expect(ran.outcome.report.run.errors).toEqual([]);
        expect(log.lines().toSorted()).toEqual(['body:fake', 'body:plain', 'body:wrapped poked only', 'setup:gadget:poked override on fake', 'teardown:gadget:poked teardown']);
      } finally {
        ran.project.cleanup();
      }
      const named = await runProject(
        { 'tests/log.ts': LOG_MODULE, 'tests/support.ts': SUPPORT, 'tests/a.e2e.ts': `import { test } from './support.ts';\ntest('names it', async ({ gadget }) => void gadget);\n` },
        { config: { targets: [targets[0]!], workers: 1 } },
      );
      try {
        expect(named.outcome.report.run.errors.map(({ code, message }) => ({ code, message }))).toEqual([
          {
            code: 'COLLECTION_ERROR',
            message: expect.stringMatching(/^tests\/support\.ts:\d+: fixture "gadget" names "gadget": target "plain" has no "gadget" fixture; available: agent, app, platform, request, screen, session \(engine fake contributes no fixtures\)$/),
          },
        ]);
      } finally {
        named.project.cleanup();
      }
    },
    120_000,
  );

  it(
    'refuses a worker-scoped override of a built-in that is a test fixture on the target, before anything runs',
    async () => {
      const support = `import { test as base } from 'e2e';

export const test = base.extend({
  gadget: [async ({ gadget }, use) => { await use(gadget); }, { scope: 'worker' }],
} as never);
`;
      const file = `import { test } from './support.ts';\ntest('one', async ({ gadget }) => void gadget);\n`;
      const fake = createFakeEngine({ fixtures: true });
      const refused = await runProject({ 'tests/support.ts': support, 'tests/a.e2e.ts': file }, { config: engineConfig(fake.engine) });
      try {
        expect(refused.outcome.report.run.errors.map(({ code, message }) => ({ code, message }))).toEqual([
          {
            code: 'COLLECTION_ERROR',
            message: expect.stringMatching(
              /^tests\/support\.ts:\d+: worker fixture "gadget" names "gadget", a test fixture on target "fake": beforeAll, afterAll, and worker fixtures see worker fixtures only/,
            ),
          },
        ]);
        expect(fake.events).toEqual([]);
      } finally {
        refused.project.cleanup();
      }
      // The same declaration is right where the engine keeps the gadget for the worker.
      const accepted = await runProject({ 'tests/support.ts': support, 'tests/a.e2e.ts': file }, { config: engineConfig(createFakeEngine({ fixtures: true, isolation: 'worker' }).engine) });
      try {
        expect(accepted.outcome.report.run.errors).toEqual([]);
        expect(resultByTitle(accepted.outcome, 'one').status).toBe('passed');
      } finally {
        accepted.project.cleanup();
      }
    },
    120_000,
  );
});
