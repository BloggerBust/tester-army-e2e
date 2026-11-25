import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resultByTitle, runProjectWithConfigFile, workerFakeConfigSource } from '../helpers/run-project.ts';

/** A helper module that registers a hook and a test while it evaluates, and counts its evaluations in `state.ts`. */
const HELPER = `import { test } from 'e2e';
import { state } from './state.ts';

state.helperLoads += 1;
test.beforeEach(() => { state.hookRan = true; });
test('from the helper', async () => {});
`;

/** A module that registers nothing: one instance for the worker, so it sees every count. */
const STATE = `export const state = { helperLoads: 0, hookRan: false, libraryLoads: 0 };
`;

/** A module whose function registers a test when a test file calls it; it registers nothing by itself. */
const LIBRARY = `import { test } from 'e2e';
import { state } from './state.ts';

state.libraryLoads += 1;
export function declareTest(title: string): void { test(title, async () => {}); }
export async function declareLater(title: string): Promise<void> {
  await Promise.resolve();
  test(title, async () => {});
}
`;

const SUPPORT = { 'tests/helper.ts': HELPER, 'tests/state.ts': STATE, 'tests/library.ts': LIBRARY };

describe('tests and hooks a test file gets from a module it imports', () => {
  it(
    'reach every test of a parallel file on one worker, which imports the file and the module one time',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
import './helper.ts';
import { declareLater, declareTest } from './library.ts';
import { state } from './state.ts';

test.describe.configure({ parallel: true });
// Each test has to get the helper's beforeEach itself: the mark of the test before it is gone.
test.afterEach(() => { state.hookRan = false; });
for (const title of ['one', 'two', 'three']) {
  test(title, async () => {
    expect(state.hookRan).toBe(true);
    expect(state.libraryLoads).toBe(1);
  });
}
declareTest('from the library');
await declareLater('from the library, later');
test('counts the imports', async () => {
  expect(state.helperLoads).toBe(1);
});`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['one', 'passed'],
        ['two', 'passed'],
        ['three', 'passed'],
        ['from the library', 'passed'],
        ['from the library, later', 'passed'],
        ['counts the imports', 'passed'],
      ]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );

  it(
    'reach every test of a parallel file from a CommonJS module, which no later import of the file evaluates again',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/state.cjs': `module.exports.state = { hookRan: false };
`,
          'tests/helper.cjs': `const { test } = require('e2e');
const { state } = require('./state.cjs');

test.beforeEach(() => { state.hookRan = true; });
`,
          'tests/file.e2e.ts': `import { createRequire } from 'node:module';
import { expect, test } from 'e2e';

const require = createRequire(import.meta.url);
require('./helper.cjs');
const { state } = require('./state.cjs');

test.describe.configure({ parallel: true });
// Each test has to get the helper's beforeEach itself: the mark of the test before it is gone.
test.afterEach(() => { state.hookRan = false; });
for (const title of ['one', 'two', 'three']) {
  test(title, async () => { expect(state.hookRan).toBe(true); });
}`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['one', 'passed'],
        ['two', 'passed'],
        ['three', 'passed'],
      ]);
    },
    120_000,
  );

  /**
   * Runs two test files on one worker that take the worker fixture `database`
   * from a module that also registers a `beforeEach`, and returns what the
   * fixture, the hook, and the tests (`log(line)` in `tests`) wrote down.
   */
  async function runWithFixtureModule(tests: (name: string) => string) {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-fixture-log-'));
    const logger = `import { appendFileSync } from 'node:fs';
const log = (line: string): void => appendFileSync(${JSON.stringify(path.join(dir, 'log'))}, line + '\\n');`;
    const file = (name: string): string => `${logger}
import { test } from './fixtures.ts';

${tests(name)}`;
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/fixtures.ts': `${logger}
import { test as base } from 'e2e';

let setups = 0;
export const test = base.extend<object, { database: number }>({
  database: [async ({ platform }, use) => {
    setups += 1;
    log('setup ' + platform);
    await use(setups);
    log('teardown');
  }, { scope: 'worker' }],
});
test.beforeEach(() => { log('hook'); });
`,
        'tests/a.e2e.ts': file('a'),
        'tests/b.e2e.ts': file('b'),
      },
      { configSource: workerFakeConfigSource(1) },
    );
    project.cleanup();
    const lines = readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n');
    rmSync(dir, { recursive: true, force: true });
    return { outcome, lines };
  }

  it(
    'leave a worker fixture one instance for two files of one worker when its module registers a hook',
    async () => {
      const { outcome, lines } = await runWithFixtureModule((name) => `test('${name}', async ({ database }) => { log('body ${name} ' + database); });`);
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.exitCode).toBe(0);
      expect(lines).toEqual(['setup fake', 'hook', 'body a 1', 'hook', 'body b 1', 'teardown']);
    },
    120_000,
  );

  it(
    'leave a worker fixture one instance for the tests after a failed one, which import its module again',
    async () => {
      const { outcome, lines } = await runWithFixtureModule((name) => `test('${name}', async ({ database }) => { log('body ${name} ' + database); });
test('${name} fails', async ({ database }) => { throw new Error('expected ' + database); });
test('${name} after the failure', async ({ database }) => { log('body ${name} again ' + database); });`);
      expect(outcome.report.run.errors).toEqual([]);
      // A failed test ends its worker once the file is done, so each file has a worker and one setup.
      expect(lines).toEqual(['a', 'b'].flatMap((name) => ['setup fake', 'hook', `body ${name} 1`, 'hook', 'hook', `body ${name} again 1`, 'teardown']));
    },
    120_000,
  );

  it(
    'give each call of a helper function its own worker fixture, in one test file and in two',
    async () => {
      const file = (name: string): string => `import { expect } from 'e2e';
import { withAccount } from './accounts.ts';

const test = withAccount('${name}');
// The helper's one test.extend() call defines a fixture each time it is called.
const other = withAccount('${name} too');
test('${name} gets its account', async ({ account }) => { expect(account).toBe('${name}'); });
other('${name} gets its other account', async ({ account }) => { expect(account).toBe('${name} too'); });`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/accounts.ts': `import { test } from 'e2e';

export function withAccount(name: string) {
  return test.extend<object, { account: string }>({
    account: [async ({ platform }, use) => { await use(platform === 'fake' ? name : platform); }, { scope: 'worker' }],
  });
}
`,
          'tests/a.e2e.ts': file('a'),
          'tests/b.e2e.ts': file('b'),
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['a gets its account', 'passed'],
        ['a gets its other account', 'passed'],
        ['b gets its account', 'passed'],
        ['b gets its other account', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'are one instance for a file and for a shared module that imports the module from a test of that file',
    async () => {
      // Only the second file runs the import, so the shared module is not known to import the helper before then.
      const file = (name: string): string => `import { expect, test } from 'e2e';
import { marker } from './helper.ts';
import { loadHelper } from './shared.ts';

test('${name} gets the instance it imported', async () => {
  expect(${name === 'a' ? 'typeof loadHelper' : '(await loadHelper()).marker'}).toBe(${name === 'a' ? "'function'" : 'marker'});
  expect(marker).toEqual({});
});`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/helper.ts': `import { test } from 'e2e';

export const marker = {};
test.beforeEach(() => {});
`,
          // Registers nothing, so it is one instance for both files.
          'tests/shared.ts': `export function loadHelper(): Promise<typeof import('./helper.ts')> {
  return import('./helper.ts');
}
`,
          'tests/a.e2e.ts': file('a'),
          'tests/b.e2e.ts': file('b'),
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['a gets the instance it imported', 'passed'],
        ['b gets the instance it imported', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'reach the second test file a worker imports, and the tests after a failed one',
    async () => {
      const file = (name: string): string => `import { expect, test } from 'e2e';
import './helper.ts';
import { state } from './state.ts';

// Each test has to get the helper's beforeEach itself: the mark of the test before it is gone.
test.afterEach(() => { state.hookRan = false; });
test('${name} fails', async () => { throw new Error('expected'); });
test('${name} runs after the failure', async () => {
  expect(state.hookRan).toBe(true);
});`;
      const { outcome, project } = await runProjectWithConfigFile(
        { ...SUPPORT, 'tests/a.e2e.ts': file('a'), 'tests/b.e2e.ts': file('b') },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      for (const name of ['a', 'b']) {
        expect(resultByTitle(outcome, `${name} fails`).status).toBe('failed');
        expect(resultByTitle(outcome, `${name} runs after the failure`).status).toBe('passed');
      }
      // Each file has the helper's test under its own path.
      expect(outcome.results.filter((result) => result.test.title === 'from the helper').map((result) => [result.test.file, result.status])).toEqual([
        ['tests/a.e2e.ts', 'passed'],
        ['tests/b.e2e.ts', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'evaluates the module once per import of the file, however often the file imports it',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
import './helper.ts';
import { state } from './state.ts';

// A second spelling of the helper, resolved once the first import made it a registrar.
await import('./helper');
test.describe.configure({ parallel: true });
for (const title of ['one', 'two']) {
  test(title, async () => {
    const loads = state.helperLoads;
    await import('./helper.ts');
    expect(state.helperLoads).toBe(loads);
  });
}`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['one', 'passed'],
        ['two', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'keeps every file in order that imports a module with nothing but describe.configure',
    async () => {
      // A file cut into several units is imported once per unit, and each import starts the count again.
      const file = (name: string): string => `import { expect, test } from 'e2e';
import './ordered.ts';

let ran = 0;
test('${name} first', async () => { ran += 1; });
test('${name} second', async () => { expect(ran).toBe(1); });`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          'tests/ordered.ts': `import { test } from 'e2e';\ntest.describe.configure({ parallel: false });\n`,
          'tests/a.e2e.ts': file('a'),
          'tests/b.e2e.ts': file('b'),
        },
        { configSource: workerFakeConfigSource(2, '\n  fullyParallel: true,') },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status]).toSorted()).toEqual([
        ['a first', 'passed'],
        ['a second', 'passed'],
        ['b first', 'passed'],
        ['b second', 'passed'],
      ]);
    },
    120_000,
  );

  it.each([
    ['the file that imports it directly comes first', './helper.ts', './between.ts'],
    ['the file that imports it through another module comes first', './between.ts', './helper.ts'],
  ])(
    'reach a file that imports the module through another one, when %s',
    async (_order, first, second) => {
      const file = (name: string, helper: string): string => `import { test } from 'e2e';
import '${helper}';

test('${name}', async () => {});`;
      const { outcome, project } = await runProjectWithConfigFile(
        { ...SUPPORT, 'tests/between.ts': `import './helper.ts';\n`, 'tests/a.e2e.ts': file('a', first), 'tests/b.e2e.ts': file('b', second) },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.file, result.test.title, result.status])).toEqual([
        ['tests/a.e2e.ts', 'from the helper', 'passed'],
        ['tests/a.e2e.ts', 'a', 'passed'],
        ['tests/b.e2e.ts', 'from the helper', 'passed'],
        ['tests/b.e2e.ts', 'b', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'reach every import of a file whose one import of the module is a dynamic one',
    async () => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/file.e2e.ts': `import { expect, test } from 'e2e';
import { state } from './state.ts';

await import('./helper.ts');
test.describe.configure({ parallel: true });
test.afterEach(() => { state.hookRan = false; });
for (const title of ['one', 'two']) test(title, async () => { expect(state.hookRan).toBe(true); });`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['one', 'passed'],
        ['two', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'reach every import of a file from a compiled module whose source map names another file',
    async () => {
      // Every line of the compiled helper maps to the same line of `helper-source.ts`, which is not on disk.
      const map = { version: 3, sources: ['helper-source.ts'], names: [], mappings: 'AAAA;AACA;AACA;AACA' };
      const compiled = `import { test } from 'e2e';
test('first from the helper', async () => {});
test('second from the helper', async () => {});
//# ${'sourceMappingURL'}=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}
`;
      const { outcome, project } = await runProjectWithConfigFile(
        { 'tests/helper.mjs': compiled, 'tests/file.e2e.ts': `import './helper.mjs';\n` },
        { configSource: workerFakeConfigSource(1, '\n  fullyParallel: true,') },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.title, result.status])).toEqual([
        ['first from the helper', 'passed'],
        ['second from the helper', 'passed'],
      ]);
    },
    120_000,
  );

  it(
    'leave a library one instance when the module awaits a function of it that declares a test',
    async () => {
      const file = (name: string): string => `import { expect, test } from 'e2e';
import './later.ts';
import { state } from './state.ts';

test('${name}', async () => { expect(state.libraryLoads).toBe(1); });`;
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          'tests/later.ts': `import { declareLater } from './library.ts';\nawait declareLater('from the library, later');\n`,
          'tests/a.e2e.ts': file('a'),
          'tests/b.e2e.ts': file('b'),
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.map((result) => [result.test.file, result.test.title, result.status])).toEqual([
        ['tests/a.e2e.ts', 'from the library, later', 'passed'],
        ['tests/a.e2e.ts', 'a', 'passed'],
        ['tests/b.e2e.ts', 'from the library, later', 'passed'],
        ['tests/b.e2e.ts', 'b', 'passed'],
      ]);
    },
    120_000,
  );

  it.each([
    ['the file that calls it imports the module too', '', `import './helper.ts';\n`],
    ['an earlier file imported the module', `import './helper.ts';\n`, ''],
  ])(
    'reach a file one time through a shared module’s function that imports the module, when %s',
    async (_shape, importInA, importInB) => {
      const { outcome, project } = await runProjectWithConfigFile(
        {
          ...SUPPORT,
          // One instance for the worker: it registers nothing, and no module it imports statically does.
          'tests/support.ts': `export async function loadHelper(): Promise<void> { await import('./helper.ts'); }\n`,
          'tests/a.e2e.ts': `import { test } from 'e2e';\n${importInA}import './support.ts';\n\ntest('a', async () => {});`,
          'tests/b.e2e.ts': `import { test } from 'e2e';\n${importInB}import { loadHelper } from './support.ts';\n\nawait loadHelper();\ntest('b', async () => {});`,
        },
        { configSource: workerFakeConfigSource(1) },
      );
      project.cleanup();
      expect(outcome.report.run.errors).toEqual([]);
      expect(outcome.results.filter((result) => result.test.file === 'tests/b.e2e.ts').map((result) => [result.test.title, result.status])).toEqual([
        ['from the helper', 'passed'],
        ['b', 'passed'],
      ]);
    },
    120_000,
  );
});
