/**
 * Services through the built runner: they start in key order before the app
 * commands and stop in reverse after them, a failed start stops the ones
 * already started, the start and stop limits abort their signal, a service
 * cancelled while it starts still stops, the yielded value is checked, tests
 * in worker processes and in the runner process call service functions and
 * get copies back, `e2e list` and the config digest start none, and
 * `e2e mcp` and `openHost` refuse a config with services.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import { defineService } from '../../src/index.ts';
import type { CommandConfig, E2EConfig, RunEvent, Service } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createProject, listProject, runExisting, runExistingWithConfigFile, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const resolveModule = new URL('../../dist/config/resolve-run.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve-run.ts');
const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');

/** An app that logs its start, with `PORT` and `ALPHA_URL`, and its stop, then serves on `PORT`. */
const SERVER = `const { appendFileSync } = require('node:fs');
appendFileSync('events.log', 'app start ' + process.env.PORT + ' ' + process.env.ALPHA_URL + '\\n');
process.on('SIGTERM', () => {
  appendFileSync('events.log', 'app stop\\n');
  process.exit(0);
});
require('node:http').createServer((_request, response) => response.end('ready')).listen(Number(process.env.PORT), '127.0.0.1');
`;

/** A service module for file-backed configs: each service logs its start, its calls, and its stop to `events.log`. */
const SERVICES = `import { appendFileSync } from 'node:fs';
import { defineService } from 'e2e';

const log = (line: string) => appendFileSync(new URL('./events.log', import.meta.url), line + '\\n');

export const logged = (name: string) =>
  defineService({
    async *start() {
      log('start ' + name);
      yield {
        url: 'http://' + name + '.test',
        record: (what: string) => {
          log(name + ' record ' + what);
          return what.length;
        },
        fail: () => {
          throw new TypeError(name + ' is down');
        },
      };
      log('stop ' + name);
    },
  });
`;

const CONFIG = `import { defineConfig } from 'e2e';
import { createFakeEngine } from '../../helpers/fake-engine.ts';
import { logged } from './services.ts';

export default defineConfig({
  workers: 2,
  services: { alpha: logged('alpha'), beta: logged('beta') },
  targets: [
    {
      name: 'fake',
      platform: 'fake',
      engine: createFakeEngine().engine,
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: ${JSON.stringify(process.execPath)},
          args: ['server.cjs'],
          shutdownTimeout: 2000,
          env: { PORT: '{port}', ALPHA_URL: 'http://alpha.test' },
        },
      },
    },
  ],
});
`;

/** A test file whose test records its worker's pid through `services.alpha`. */
const recordingTest = (title: string): string => `import { test } from 'e2e';
test('${title}', async ({ services }) => {
  const alpha = services['alpha'] as { record(what: string): Promise<number> };
  const length = await alpha.record(String(process.pid));
  if (length !== String(process.pid).length) {
    throw new Error('record returned ' + length);
  }
});
`;

/** The run's errors as code and message. */
const runErrors = (outcome: RunOutcome) => outcome.report.run.errors.map(({ code, message }) => ({ code, message }));

/** The last attempt's error message of the test titled `title`. */
const failureOf = (outcome: RunOutcome, title: string): string | undefined =>
  outcome.results.find((result) => result.test.title === title)?.attempts.at(-1)?.error?.message;

/** A fake target whose app command runs `server.cjs` on a free port, with `env` as its env. */
function commandTarget(env: NonNullable<CommandConfig['env']>) {
  return {
    name: 'fake',
    platform: 'fake',
    engine: createFakeEngine().engine,
    app: { url: 'http://127.0.0.1:0', command: { executable: process.execPath, args: ['server.cjs'], shutdownTimeout: 2000, env } },
  };
}

/** The lines of `events.log` in the project. */
const eventLines = (project: Pick<FixtureProject, 'dir'>): string[] => readFileSync(path.join(project.dir, 'events.log'), 'utf8').trim().split('\n');

const PASSING_TEST = `import { test } from 'e2e';
test('passes', async () => {});
`;

/** An `onEvent` that aborts `interrupt`, as a first Ctrl+C does, once the service `name` has started. */
const interruptOnceStarted = (interrupt: AbortController, name: string) => (event: RunEvent): void => {
  if (event.type === 'setup' && event.state === 'finished' && event.step.kind === 'service' && event.step.label === `service "${name}"`) {
    interrupt.abort();
  }
};

describe('services', { timeout: 60_000 }, () => {
  const projects: FixtureProject[] = [];

  afterEach(() => {
    for (const project of projects.splice(0)) {
      project.cleanup();
    }
  });

  /** Runs `files` in-process with `config` on top of the fake target. */
  async function runInProcess(files: Readonly<Record<string, string>>, config: Partial<E2EConfig>, runOptions = {}): Promise<RunOutcome> {
    const { outcome, project } = await runProject(files, { config, runOptions });

    projects.push(project);

    return outcome;
  }

  it('starts services in key order before the app commands, stops them in reverse after, and serves calls from worker processes', async () => {
    const project = createProject({
      'services.ts': SERVICES,
      'server.cjs': SERVER,
      'e2e.config.ts': CONFIG,
      'tests/one.e2e.ts': recordingTest('one'),
      'tests/two.e2e.ts': recordingTest('two'),
      'tests/fail.e2e.ts': `import { test } from 'e2e';
test('calls a function that throws', async ({ services }) => {
  await (services['beta'] as { fail(): Promise<void> }).fail();
});
`,
    });

    projects.push(project);

    const outcome = await runExistingWithConfigFile(project, {});

    const events = eventLines(project);
    const port = outcome.config?.ports['fake'];

    expect(port).toBeGreaterThan(0);
    expect(events.filter((line) => !line.includes(' record '))).toEqual([
      'start alpha',
      'start beta',
      `app start ${port} http://alpha.test`,
      'app stop',
      'stop beta',
      'stop alpha',
    ]);

    const recordedPids = events.filter((line) => line.startsWith('alpha record ')).map((line) => Number(line.slice('alpha record '.length)));

    expect(recordedPids).toHaveLength(2);
    expect(recordedPids).not.toContain(process.pid);
    expect(outcome.results.filter((result) => result.status === 'passed').map((result) => result.test.title).toSorted()).toEqual(['one', 'two']);
    expect(failureOf(outcome, 'calls a function that throws')).toBe('services.beta.fail() failed: beta is down');
    expect(runErrors(outcome)).toEqual([]);
  });

  it('copies data to tests in the runner process and calls functions there', async () => {
    const items = ['first'];

    class InboxError extends Error {
      override readonly name = 'InboxError';
      readonly code = 'E_GONE';
    }

    class Inbox {
      readonly url = 'http://inbox.test';
    }

    const shared = { count: 1 };
    const loop: Record<string, unknown> = { name: 'loop' };

    loop['self'] = loop;

    const outcome = await runInProcess(
      {
        'tests/calls.e2e.ts': `import { expect, test } from 'e2e';
type Store = {
  items: string[];
  when: Date;
  bytes: Uint8Array;
  nested: { readers: { read(): Promise<string> }[] };
  pair: { count: number }[];
  loop: { name: string; self: unknown; reader: { read(): Promise<string> } };
  tags: Set<string>;
  byName: Map<string, { id: number }>;
  size(): Promise<number>;
  add(item: unknown): Promise<number>;
  fail(): Promise<void>;
  reject(): Promise<void>;
  leak(): Promise<unknown>;
  find(): Promise<unknown>;
};
class Note {
  readonly text = 'hi';
}
test('reads data and calls functions', async ({ services }) => {
  const store = services['store'] as Store;
  store.items.push('local');
  expect(await store.size()).toBe(1);
  expect(await store.add('second')).toBe(2);
  expect(store.when instanceof Date).toBe(true);
  expect(store.bytes instanceof Uint8Array).toBe(true);
  expect(await store.nested.readers[0]!.read()).toBe('read');
});
test('keeps shared references, cycles, maps, and sets', async ({ services }) => {
  const store = services['store'] as Store;
  expect(store.pair[0]).toBe(store.pair[1]);
  expect(store.loop.self).toBe(store.loop);
  expect(await store.loop.reader.read()).toBe('loop');
  expect(store.tags).toEqual(new Set(['a']));
  expect(store.byName.get('ada')).toEqual({ id: 1 });
});
test('gets a copy of a thrown error', async ({ services }) => {
  await (services['store'] as Store).fail();
});
test('gets the name and properties of a thrown error', async ({ services }) => {
  const error: unknown = await (services['store'] as Store).reject().catch((cause: unknown) => cause);
  expect(error instanceof Error).toBe(true);
  expect(error).toMatchObject({ name: 'InboxError', code: 'E_GONE', message: 'services.store.reject() failed: the inbox is gone' });
});
test('passes an argument that cannot be copied', async ({ services }) => {
  await (services['store'] as Store).add(() => 'x');
});
test('passes a class instance', async ({ services }) => {
  await (services['store'] as Store).add({ note: new Note() });
});
test('gets a result that cannot be copied', async ({ services }) => {
  await (services['store'] as Store).leak();
});
test('gets a class instance', async ({ services }) => {
  await (services['store'] as Store).find();
});
`,
      },
      {
        services: {
          store: defineService({
            // @ts-expect-error leak and find return values that can't be copied, so the runtime check can refuse them
            async *start() {
              yield {
                items,
                when: new Date(0),
                bytes: Buffer.from('abc'),
                nested: { readers: [{ read: () => 'read' }] },
                pair: [shared, shared],
                loop: Object.assign(loop, { reader: { read: () => 'loop' } }),
                tags: new Set(['a']),
                byName: new Map([['ada', { id: 1 }]]),
                size: () => items.length,
                add: (item: string) => items.push(item),
                fail: () => {
                  throw new RangeError('the store is full');
                },
                reject: () => {
                  throw new InboxError('the inbox is gone');
                },
                leak: () => () => 'a function',
                find: () => new Inbox(),
              };
            },
          }),
        },
      },
    );

    expect(failureOf(outcome, 'reads data and calls functions')).toBeUndefined();
    expect(failureOf(outcome, 'keeps shared references, cycles, maps, and sets')).toBeUndefined();
    expect(items).toEqual(['first', 'second']);
    expect(failureOf(outcome, 'gets a copy of a thrown error')).toBe('services.store.fail() failed: the store is full');
    expect(failureOf(outcome, 'gets the name and properties of a thrown error')).toBeUndefined();
    expect(failureOf(outcome, 'passes an argument that cannot be copied')).toBe("services.store.add() was passed a function at arguments[0], which can't be copied to the service");
    expect(failureOf(outcome, 'passes a class instance')).toBe(
      "services.store.add() was passed an instance of Note at arguments[0].note, which loses its class when it's copied to the service. Put its data in a plain object",
    );
    expect(failureOf(outcome, 'gets a result that cannot be copied')).toBe("services.store.leak() failed: it returned a function, which can't be copied to the caller");
    expect(failureOf(outcome, 'gets a class instance')).toBe(
      "services.store.find() failed: it returned an instance of Inbox, which loses its class when it's copied to the caller. Put its data in a plain object",
    );
  });

  it('gives each worker in the runner process its own copy of the data', async () => {
    const outcome = await runInProcess(
      {
        'tests/a.e2e.ts': `import { expect, test } from 'e2e';
test('adds an item', async ({ services }) => {
  const list = services['list'] as { items: string[] };
  list.items.push('added');
  expect(list.items).toEqual(['first', 'added']);
});
`,
      },
      {
        services: {
          list: defineService({
            async *start() {
              yield { items: ['first'] };
            },
          }),
        },
        targets: [
          { name: 'a', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP },
          { name: 'b', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP },
        ],
      },
    );

    expect(outcome.results.map((result) => [result.target.name, result.status])).toEqual([
      ['a', 'passed'],
      ['b', 'passed'],
    ]);
  });

  it('gives the services to suite hooks and to fixtures of both scopes', async () => {
    const outcome = await runInProcess(
      {
        'tests/a.e2e.ts': `import { expect, test as base } from 'e2e';
type Mail = { url: string; count(): Promise<number> };
const test = base.extend<{ testUrl: string }, { workerUrl: string }>({
  workerUrl: [
    async ({ services }, use) => {
      await use((services['mail'] as Mail).url);
    },
    { scope: 'worker' },
  ],
  testUrl: async ({ services }, use) => {
    await use((services['mail'] as Mail).url);
  },
});
let counted = 0;
test.beforeAll(async ({ services }) => {
  counted = await (services['mail'] as Mail).count();
});
test('reads services in hooks and fixtures', async ({ workerUrl, testUrl }) => {
  expect([counted, workerUrl, testUrl]).toEqual([3, 'http://mail.test', 'http://mail.test']);
});
`,
      },
      {
        services: {
          mail: defineService({
            async *start() {
              yield { url: 'http://mail.test', count: () => 3 };
            },
          }),
        },
      },
    );

    expect(outcome.results.map((result) => [result.status, result.attempts.at(-1)?.error?.message])).toEqual([['passed', undefined]]);
  });

  it('gives each worker process its own copy of the data, sends every call to the one service in the runner process, and puts the test line in the stack of a failure', async () => {
    const changingTest = (title: string): string => `import { expect, test } from 'e2e';
test('${title}', async ({ services }) => {
  const counter = services['counter'] as { items: string[]; bump(pid: number): Promise<number>; fail(): Promise<void> };
  expect(counter.items).toEqual(['first']);
  counter.items.push('${title}');
  await counter.bump(process.pid);
  const error = await counter.fail().catch((cause: unknown) => cause);
  expect(String((error as Error).stack)).toMatch(/at .*${title}\\.e2e\\.ts\\S*:\\d+:\\d+/);
});
`;

    const project = createProject({
      'e2e.config.ts': `import { appendFileSync } from 'node:fs';
import { defineConfig, defineService } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

let count = 0;
const counter = defineService({
  async *start() {
    yield {
      items: ['first'],
      bump: (pid: number) => {
        count += 1;
        appendFileSync(new URL('./events.log', import.meta.url), 'bump ' + count + ' from ' + pid + ' in ' + process.pid + '\\n');
        return count;
      },
      fail: () => {
        throw new Error('the counter is down');
      },
    };
  },
});

export default defineConfig({
  workers: 2,
  services: { counter },
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }],
});
`,
      'tests/one.e2e.ts': changingTest('one'),
      'tests/two.e2e.ts': changingTest('two'),
    });

    projects.push(project);

    const outcome = await runExistingWithConfigFile(project, {});

    expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);

    const bumps = eventLines(project).map((line) => /^bump (\d+) from (\d+) in (\d+)$/.exec(line)?.slice(1).map(Number));

    expect(bumps.map((bump) => bump?.[0])).toEqual([1, 2]);

    const workerPids = new Set(bumps.map((bump) => bump?.[1]));

    expect(workerPids.size).toBe(2);
    expect(workerPids.has(process.pid)).toBe(false);
    expect(bumps.map((bump) => bump?.[2])).toEqual([process.pid, process.pid]);
  });

  it('calls functions without this, copies arguments and results both ways, and puts the test line in the stack of a failure', async () => {
    const received: string[][] = [];

    const outcome = await runInProcess(
      {
        'tests/stack.e2e.ts': `import { expect, test } from 'e2e';
type Tools = {
  self(): Promise<string>;
  greet(name: string): Promise<string>;
  keep(items: string[]): Promise<string[]>;
  fail(): Promise<void>;
};
test('calls functions', async ({ services }) => {
  const tools = services['tools'] as Tools;
  expect(await tools.self()).toBe('no this');
  expect(await tools.greet('ada')).toBe('hi ada');
  const items = ['a'];
  const kept = await tools.keep(items);
  expect(kept).toEqual(['a', 'kept']);
  expect(items).toEqual(['a']);
  kept.push('local');
});
test('fails', async ({ services }) => {
  const error = await (services['tools'] as Tools).fail().catch((cause: unknown) => cause);
  expect(error instanceof Error).toBe(true);
  const stack = (error as Error).stack ?? '';
  expect(stack.split('\\n')[0]).toBe('Error: services.tools.fail() failed: the tool is down');
  expect(stack).toMatch(/at .*stack\\.e2e\\.ts\\S*:\\d+:\\d+/);
});
`,
      },
      {
        services: {
          tools: defineService({
            async *start() {
              yield {
                self(this: unknown) {
                  return this === undefined ? 'no this' : 'has this';
                },
                greet: (name: string) => `hi ${name}`,
                keep: (items: string[]) => {
                  received.push(items);
                  items.push('kept');
                  return items;
                },
                fail: () => {
                  throw new Error('the tool is down');
                },
              };
            },
          }),
        },
      },
    );

    expect(outcome.results.map((result) => [result.test.title, result.status, failureOf(outcome, result.test.title)])).toEqual([
      ['calls functions', 'passed', undefined],
      ['fails', 'passed', undefined],
    ]);
    expect(received).toEqual([['a', 'kept']]);
  });

  it('keeps the type of nested maps and sets, regular expressions, built-in errors, buffers, typed arrays, bigints, and undefined', async () => {
    const outcome = await runInProcess(
      {
        'tests/types.e2e.ts': `import { expect, test } from 'e2e';
test('reads each type', async ({ services }) => {
  const kept = services['kept'] as {
    groups: Map<string, Set<Map<string, number>>>;
    pattern: RegExp;
    failure: TypeError;
    buffer: Buffer;
    floats: Float64Array;
    big: bigint;
    missing: undefined;
  };
  const [members] = [...(kept.groups.get('admins') ?? [])];
  expect(members instanceof Map && members.get('ada')).toBe(1);
  expect(kept.pattern instanceof RegExp && kept.pattern.source + '/' + kept.pattern.flags).toBe('in(box)?/gi');
  expect(kept.failure instanceof TypeError && kept.failure.message).toBe('bad type');
  expect(Buffer.isBuffer(kept.buffer) && kept.buffer.toString()).toBe('abc');
  expect(kept.floats instanceof Float64Array && kept.floats[0]).toBe(1.5);
  expect(kept.big).toBe(10n ** 20n);
  expect('missing' in kept && kept.missing === undefined).toBe(true);
});
`,
      },
      {
        services: {
          kept: defineService({
            async *start() {
              yield {
                groups: new Map([['admins', new Set([new Map([['ada', 1]])])]]),
                pattern: /in(box)?/gi,
                failure: new TypeError('bad type'),
                buffer: Buffer.from('abc'),
                floats: new Float64Array([1.5]),
                big: 10n ** 20n,
                missing: undefined,
              };
            },
          }),
        },
      },
    );

    expect(runErrors(outcome)).toEqual([]);
    expect(outcome.results.map((result) => [result.status, failureOf(outcome, result.test.title)])).toEqual([['passed', undefined]]);
  });

  it('stops the services that started when a later one fails to start, and starts no app command', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const events: string[] = [];

    const outcome = await runExisting(project, {
      config: {
        services: {
          first: defineService({
            async *start() {
              events.push('start first');
              yield {};
              events.push('stop first');
            },
          }),
          broken: defineService({
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start() {
              events.push('start broken');
              throw new Error('port 4010 is taken');
            },
          }),
          never: defineService({
            async *start() {
              events.push('start never');
              yield {};
            },
          }),
        },
        targets: [commandTarget({ PORT: '{port}' })],
      },
    });

    expect(events).toEqual(['start first', 'start broken', 'stop first']);
    expect(runErrors(outcome)).toEqual([{ code: 'SERVICE_START_FAILED', message: 'service "broken" failed to start: port 4010 is taken' }]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.results.some((result) => result.status === 'passed')).toBe(false);
    expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
  });

  it('reports a cleanup error for a service that fails to stop after a later one fails to start', async () => {
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        first: defineService({
          async *start() {
            yield {};
            throw new Error('could not flush the inbox');
          },
        }),
        broken: defineService({
          // oxlint-disable-next-line require-yield -- this service fails before it yields, which is what the test checks
          async *start() {
            throw new Error('port 4010 is taken');
          },
        }),
      },
    });

    expect(outcome.report.run.errors.map(({ code, message, phase }) => ({ code, message, phase }))).toEqual([
      { code: 'SERVICE_STOP_FAILED', message: 'service "first" failed to stop: could not flush the inbox', phase: 'cleanup' },
      { code: 'SERVICE_START_FAILED', message: 'service "broken" failed to start: port 4010 is taken', phase: undefined },
    ]);
  });

  const startCases: { start: Service['start']; error: { code: string; message: string } }[] = [
    {
      start: async function* () {},
      error: {
        code: 'SERVICE_START_FAILED',
        message: 'service "inbox" finished without yielding. Yield a value once between the startup code and the stop code',
      },
    },
    {
      // @ts-expect-error -- a generator that isn't async, which the runner refuses
      start: function* () {
        yield {};
      },
      error: { code: 'SERVICE_START_FAILED', message: 'service "inbox" needs an async generator for start, like async *start() { ... }' },
    },
    {
      // @ts-expect-error -- a plain function, which the runner refuses
      start: () => ({ url: 'http://inbox.test' }),
      error: { code: 'SERVICE_START_FAILED', message: 'service "inbox" needs an async generator for start, like async *start() { ... }' },
    },
    {
      // @ts-expect-error -- an async function that isn't a generator; its rejection must not go unhandled
      start: async () => {
        throw new Error('no inbox today');
      },
      error: { code: 'SERVICE_START_FAILED', message: 'service "inbox" needs an async generator for start, like async *start() { ... }' },
    },
    {
      // @ts-expect-error -- an async iterator whose next() throws instead of returning a promise
      start: () => ({
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          throw new Error('no inbox today');
        },
      }),
      error: { code: 'SERVICE_START_FAILED', message: 'service "inbox" failed to start: no inbox today' },
    },
    {
      start: async function* () {
        yield {};
        throw new Error('could not flush the inbox');
      },
      error: { code: 'SERVICE_STOP_FAILED', message: 'service "inbox" failed to stop: could not flush the inbox' },
    },
  ];

  it.each(startCases)('reports $error.message', async ({ start, error }) => {
    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, { services: { inbox: { start } } });

    expect(runErrors(outcome)).toEqual([error]);
  });

  it.each(['the plain object', 'the map'])('refuses a function a map reaches through a shared reference when %s is walked first', async (first) => {
    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          inbox: defineService({
            async *start() {
              const shared: { owner?: unknown } = {};
              const owner = { shared, read: () => 1 };

              shared.owner = owner;

              const map = new Map([[1, shared]]);

              yield first === 'the map' ? { map, owner } : { owner, map };
            },
          }),
        },
      },
    );

    expect(runErrors(outcome).map(({ code }) => code)).toEqual(['INVALID_SERVICE_VALUE']);
  });

  it('refuses an instance of an array subclass', async () => {
    class Inboxes extends Array<string> {}

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          inbox: defineService({
            async *start() {
              yield { inboxes: Inboxes.from(['ada']) };
            },
          }),
        },
      },
    );

    expect(runErrors(outcome)).toEqual([
      {
        code: 'INVALID_SERVICE_VALUE',
        message: 'service "inbox" yielded an instance of Inboxes at inboxes, which loses its class when it\'s copied to tests. Put its data in a plain object',
      },
    ]);
  });

  it('aborts the signal and fails the run when a service does not yield within the start limit', async () => {
    let reason: unknown;

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          slow: defineService({
            startupTimeout: 100,
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start({ signal }) {
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
              reason = signal.reason;
            },
          }),
        },
      },
    );

    expect(runErrors(outcome)).toEqual([{ code: 'SERVICE_START_FAILED', message: 'service "slow" didn\'t yield within 0.1 seconds' }]);
    await expect.poll(() => reason).toBeInstanceOf(Error);
  });

  it('aborts the signal of a service still starting when the run is interrupted', async () => {
    const interrupt = new AbortController();
    let aborted = false;

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          slow: defineService({
            // oxlint-disable-next-line require-yield -- this service fails or is stopped before it yields, which is what the test checks
            async *start({ signal }) {
              const done = new Promise((resolve) => signal.addEventListener('abort', resolve));
              interrupt.abort();
              await done;
              aborted = true;
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal },
    );

    expect(outcome.status).toBe('interrupted');
    expect(runErrors(outcome)).toEqual([]);
    await expect.poll(() => aborted).toBe(true);
  });

  it.each([
    { cancel: 'the run is interrupted', options: {}, runOptions: (interrupt: AbortController) => ({ interruptSignal: interrupt.signal }), errors: [] },
    {
      cancel: 'it does not yield within the start limit',
      options: { startupTimeout: 100 },
      runOptions: () => ({}),
      errors: [{ code: 'SERVICE_START_FAILED', message: 'service "late" didn\'t yield within 0.1 seconds' }],
    },
  ])('runs the stop code of a service that yields after $cancel, before the run ends', async ({ options, runOptions, errors }) => {
    const interrupt = new AbortController();
    const events: string[] = [];

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          late: defineService({
            ...options,
            async *start({ signal }) {
              const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve));
              interrupt.abort();
              await aborted;
              await new Promise((resolve) => setTimeout(resolve, 100));
              events.push('yield late');
              yield {};
              events.push('stop late');
            },
          }),
        },
      },
      runOptions(interrupt),
    );

    expect(runErrors(outcome)).toEqual(errors);
    expect(events).toEqual(['yield late', 'stop late']);
  });

  it.each([
    { cancel: 'the run is interrupted', options: {}, runOptions: (interrupt: AbortController) => ({ interruptSignal: interrupt.signal }), errors: [] },
    {
      cancel: 'it does not yield within the start limit',
      options: { startupTimeout: 100 },
      runOptions: () => ({}),
      errors: [{ code: 'SERVICE_START_FAILED', message: 'service "stuck" didn\'t yield within 0.1 seconds' }],
    },
  ])('reports no stop failure for a service that never yields after $cancel', async ({ options, runOptions, errors }) => {
    const interrupt = new AbortController();

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          stuck: defineService({
            ...options,
            shutdownTimeout: 200,
            // oxlint-disable-next-line require-yield -- this service never yields, which is what the test checks
            async *start() {
              interrupt.abort();
              await new Promise(() => undefined);
            },
          }),
        },
      },
      runOptions(interrupt),
    );

    expect(runErrors(outcome)).toEqual(errors);
  });

  it('starts no service code when a handler of the starting event cancels the run', async () => {
    const interrupt = new AbortController();
    let entered = false;

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          inbox: defineService({
            async *start() {
              entered = true;
              yield {};
            },
          }),
        },
      },
      {
        interruptSignal: interrupt.signal,
        onEvent: (event: RunEvent) => {
          if (event.type === 'setup' && event.state === 'started' && event.step.kind === 'service') {
            interrupt.abort();
          }
        },
      },
    );

    expect(outcome.status).toBe('interrupted');
    expect(entered).toBe(false);
  });

  it('aborts the signal of every started service on a second Ctrl+C, so stop code can wait on another service', async () => {
    const interrupt = new AbortController();
    const force = new AbortController();
    let resolveFirstAborted = (): void => undefined;
    const firstAborted = new Promise<void>((resolve) => {
      resolveFirstAborted = resolve;
    });
    const events: string[] = [];

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          first: defineService({
            async *start({ signal }) {
              signal.addEventListener('abort', () => resolveFirstAborted());
              yield {};
            },
          }),
          second: defineService({
            shutdownTimeout: 1000,
            async *start() {
              yield {};
              force.abort();
              await firstAborted;
              events.push('stop second');
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal, forceSignal: force.signal, onEvent: interruptOnceStarted(interrupt, 'second') },
    );

    expect(runErrors(outcome)).toEqual([]);
    expect(events).toEqual(['stop second']);
  });

  it('runs the stop code with the signal live after a first Ctrl+C', async () => {
    const interrupt = new AbortController();
    const aborted: boolean[] = [];

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          alpha: defineService({
            async *start({ signal }) {
              yield {};
              aborted.push(signal.aborted);
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal, onEvent: interruptOnceStarted(interrupt, 'alpha') },
    );

    expect(outcome.status).toBe('interrupted');
    expect(aborted).toEqual([false]);
  });

  it('aborts the signal of the stopping service and of the ones after it on a second Ctrl+C', async () => {
    const interrupt = new AbortController();
    const force = new AbortController();
    const events: string[] = [];
    const startedAt = Date.now();

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          first: defineService({
            async *start({ signal }) {
              yield {};
              events.push(`stop first, aborted: ${signal.aborted}`);
            },
          }),
          second: defineService({
            async *start({ signal }) {
              yield {};
              const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve));
              force.abort();
              await aborted;
              events.push('stop second');
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal, forceSignal: force.signal, onEvent: interruptOnceStarted(interrupt, 'second') },
    );

    expect(outcome.status).toBe('interrupted');
    expect(runErrors(outcome)).toEqual([]);
    expect(events).toEqual(['stop second', 'stop first, aborted: true']);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('stops waiting for a service that has not yielded yet on a second Ctrl+C', async () => {
    const interrupt = new AbortController();
    const force = new AbortController();
    const events: string[] = [];
    const startedAt = Date.now();

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          late: defineService({
            async *start({ signal }) {
              const aborted = new Promise((resolve) => signal.addEventListener('abort', resolve));
              interrupt.abort();
              await aborted;
              setTimeout(() => force.abort(), 100);
              await new Promise((resolve) => setTimeout(resolve, 8_000));
              yield {};
              events.push('stop late');
            },
          }),
        },
      },
      { interruptSignal: interrupt.signal, forceSignal: force.signal },
    );

    expect(outcome.status).toBe('interrupted');
    expect(runErrors(outcome)).toEqual([]);
    expect(events).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('aborts the signal and reports a cleanup error when the stop code does not finish within the stop limit', async () => {
    let aborted = false;

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          stuck: defineService({
            shutdownTimeout: 100,
            async *start({ signal }) {
              yield {};
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
              aborted = true;
            },
          }),
        },
      },
    );

    expect(outcome.report.run.errors).toEqual([
      expect.objectContaining({ code: 'SERVICE_STOP_FAILED', message: 'service "stuck" didn\'t stop within 0.1 seconds', phase: 'cleanup' }),
    ]);
    expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
    await expect.poll(() => aborted).toBe(true);
  });

  it('ends a service that yields a second time and runs its finally block', async () => {
    let finished = false;

    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        twice: defineService({
          async *start() {
            try {
              yield {};
              yield {};
            } finally {
              finished = true;
            }
          },
        }),
      },
    });

    expect(runErrors(outcome)).toEqual([
      { code: 'SERVICE_STOP_FAILED', message: 'service "twice" yielded a second time. Yield only once, and put stop code after the yield' },
    ]);
    expect(finished).toBe(true);
  });

  it('stops the services before one that fails to stop, whichever way it fails', async () => {
    const events: string[] = [];
    let stuckAborted = false;

    const outcome = await runInProcess(
      { 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          first: defineService({
            async *start() {
              yield {};
              events.push('stop first');
            },
          }),
          throwing: defineService({
            async *start() {
              yield {};
              events.push('stop throwing');
              throw new Error('could not flush the inbox');
            },
          }),
          twice: defineService({
            async *start() {
              yield {};
              events.push('stop twice');
              yield {};
            },
          }),
          stuck: defineService({
            shutdownTimeout: 100,
            async *start({ signal }) {
              yield {};
              events.push('stop stuck');
              await new Promise((resolve) => signal.addEventListener('abort', resolve));
              stuckAborted = true;
            },
          }),
        },
      },
    );

    expect(outcome.report.run.errors.map(({ code, message, phase }) => ({ code, message, phase }))).toEqual([
      { code: 'SERVICE_STOP_FAILED', message: 'service "stuck" didn\'t stop within 0.1 seconds', phase: 'cleanup' },
      { code: 'SERVICE_STOP_FAILED', message: 'service "twice" yielded a second time. Yield only once, and put stop code after the yield', phase: 'cleanup' },
      { code: 'SERVICE_STOP_FAILED', message: 'service "throwing" failed to stop: could not flush the inbox', phase: 'cleanup' },
    ]);
    expect(events).toEqual(['stop stuck', 'stop twice', 'stop throwing', 'stop first']);
    await expect.poll(() => stuckAborted).toBe(true);
  });

  class Inbox {
    readonly url = 'http://inbox.test';
  }

  class InboxError extends Error {}

  it.each([
    { value: 'http://inbox.test', message: 'service "bad" yielded a string. Yield a plain object, like { url }' },
    { value: { inbox: new Inbox() }, message: 'service "bad" yielded an instance of Inbox at inbox, which loses its class when it\'s copied to tests. Put its data in a plain object' },
    {
      value: { inboxes: new Set([new Inbox()]) },
      message: 'service "bad" yielded an instance of Inbox inside a Set at inboxes, which loses its class when it\'s copied to tests. Put its data in a plain object',
    },
    { value: { tokens: new Map([['ada', () => 'token']]) }, message: 'service "bad" yielded a function inside a Map at tokens, but only plain objects and arrays can hold functions for tests' },
    { value: { hooks: new Set([() => 'hook']) }, message: 'service "bad" yielded a function inside a Set at hooks, but only plain objects and arrays can hold functions for tests' },
    {
      value: { last: { failure: new InboxError('the inbox is gone') } },
      message: 'service "bad" yielded an instance of InboxError at last.failure, which loses its class when it\'s copied to tests. Put its data in a plain object',
    },
    { value: { tag: Symbol('tag') }, message: "service \"bad\" yielded a value at tag that can't be copied to tests: Symbol(tag) could not be cloned." },
    { value: { counter: new SharedArrayBuffer(8) }, message: "service \"bad\" yielded an instance of SharedArrayBuffer at counter, which can't be copied to tests. Put its data in a plain object" },
  ])('fails the run when a service yields $message', async ({ value, message }) => {
    let stopped = false;

    const outcome = await runInProcess({ 'tests/a.e2e.ts': PASSING_TEST }, {
      services: {
        bad: {
          async *start() {
            yield value as object;
            stopped = true;
          },
        } satisfies Service,
      },
    });

    expect(runErrors(outcome)).toEqual([{ code: 'INVALID_SERVICE_VALUE', message: expect.stringContaining(message) }]);
    expect(outcome.exitCode).toBe(2);
    expect(stopped).toBe(true);
  });

  it('lists tests without starting a service', async () => {
    let started = false;

    const { pairs, project } = await listProject({ 'tests/a.e2e.ts': PASSING_TEST }, {
      config: {
        services: {
          loud: defineService({
            async *start() {
              started = true;
              yield {};
            },
          }),
        },
      },
    });

    projects.push(project);

    expect(pairs.map((pair) => pair.title)).toEqual(['passes']);
    expect(started).toBe(false);
  });

  it('keeps the config digest, and with it the replay cache, when services are added', () => {
    const service = defineService({
      async *start() {
        yield {};
      },
    });

    const engine = createFakeEngine().engine;
    const app = { url: 'http://127.0.0.1:4000', command: { executable: 'node', args: ['server.cjs'] } };
    const digest = (config: E2EConfig): string => resolveConfig(config, { projectRoot: '/repo', env: {} }).configDigest;
    const plain = digest({ targets: [{ name: 'fake', platform: 'fake', engine, app }] });

    expect(digest({ services: { service }, targets: [{ name: 'fake', platform: 'fake', engine, app }] })).toBe(plain);
  });

  it('refuses an engine fixture named services', () => {
    expect(() => defineEngine({ name: 'shadow', version: '1.0.0', spiVersion: 1, platform: 'shadow', fixtures: { services: () => ({}) } })).toThrow(
      'fixture name "services" shadows a universal fixture',
    );
  });

  describe('openHost', () => {
    const harness = hostHarness();

    it('refuses a config with services', async () => {
      const engine = createFakeEngine().engine;
      let started = false;

      const config = harness.config(engine, {
        services: {
          inbox: defineService({
            async *start() {
              started = true;
              yield {};
            },
          }),
        },
      });

      await expect(harness.host(engine, { config })).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        message: "openHost doesn't start services, and this config declares services (inbox). Run these tests with e2e run instead.",
      });
      expect(started).toBe(false);
    });
  });

  describe('e2e mcp', () => {
    it('refuses to open a session on a config with services', async () => {
      const project = createProject({});

      projects.push(project);

      let started = false;

      const config: E2EConfig = {
        services: {
          inbox: defineService({
            async *start() {
              started = true;
              yield {};
            },
          }),
        },
        targets: [{ name: 'kiosk', platform: 'kiosk', engine: createFakeEngine().engine, app: FAKE_APP }],
      };

      const host = new SessionHost({
        locateConfig: () => path.join(project.dir, 'e2e.config.ts'),
        loadConfig: async (configPath) => ({ ...resolveConfig(config, { projectRoot: project.dir, env: {}, configPath }), configPath }),
        loadEngineConfig: async () => {
          throw new Error('no engine sessions here');
        },
        env: {},
        headed: false,
        log: () => undefined,
        maxSessions: 1,
      });

      await expect(host.open({})).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        message: "e2e mcp doesn't start services, and this config declares services (inbox). Run these tests with e2e run instead.",
      });
      expect(started).toBe(false);
      expect(host.isOpen).toBe(false);
    });
  });
});
