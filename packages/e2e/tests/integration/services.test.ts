/**
 * Services through the built runner: they start in key order before the app
 * commands and stop in reverse after them, a failed start stops the ones
 * already started, the start and stop limits abort their signal, a service
 * cancelled while it starts still stops, the yielded value is checked, tests
 * in worker processes and in the runner process call service functions and
 * get copies back, an `env` function reads the services once per run,
 * `e2e list` and the config digest start none, `e2e mcp` sessions on one
 * config file share one start, and `openHost` starts them for its host.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import { InfrastructureError } from '@e2e-dev/core/lib/internal/errors';
import { defineService } from '../../src/index.ts';
import type { CommandConfig, E2EConfig, RunEvent, Service } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { freePort } from '../helpers/free-port.ts';
import { credentials, hostHarness, secrets } from '../helpers/open-host.ts';
import { createProject, listProject, runExisting, runExistingWithConfigFile, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const resolveModule = new URL('../../dist/config/resolve-run.js', import.meta.url).href;
const { resolveConfig } = (await import(resolveModule)) as typeof import('../../src/config/resolve-run.ts');
const sessionModule = new URL('../../dist/mcp/session.js', import.meta.url).href;
const { SessionHost } = (await import(sessionModule)) as typeof import('../../src/mcp/session.ts');
const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

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

const CONFIG = `import { appendFileSync } from 'node:fs';
import { defineConfig } from 'e2e';
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
          env: ({ services }) => {
            appendFileSync(new URL('./events.log', import.meta.url), 'env\\n');
            return { PORT: '{port}', ALPHA_URL: services.alpha.url };
          },
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

/** A fake target whose app command runs `server.cjs` on a free port, with `env` as its env and `extra` on top. */
function commandTarget(env: NonNullable<CommandConfig['env']>, extra: Partial<CommandConfig> = {}) {
  return {
    name: 'fake',
    platform: 'fake',
    engine: createFakeEngine().engine,
    app: { url: 'http://127.0.0.1:0', command: { executable: process.execPath, args: ['server.cjs'], shutdownTimeout: 2000, env, ...extra } },
  };
}

/**
 * A config on the fake engine whose `alpha` and `beta` services and app
 * command log to `events.log` in `dir`, as `CONFIG` does. The app runs
 * `SERVER` on `port`, so sessions that open on it share one process.
 * `failing` names a service that throws as it starts, or `env` for an env
 * function that throws.
 */
function loggingConfig(dir: string, port: number, failing?: string): E2EConfig {
  const log = (line: string): void => appendFileSync(path.join(dir, 'events.log'), `${line}\n`);

  const service = (name: string): Service =>
    defineService({
      async *start() {
        log(`start ${name}`);

        if (name === failing) {
          throw new Error(`${name} is down`);
        }

        yield {
          url: `http://${name}.test`,
          record: (what: string) => {
            log(`${name} record ${what}`);

            return what.length;
          },
        };

        log(`stop ${name}`);
      },
    });

  return {
    services: { alpha: service('alpha'), beta: service('beta') },
    targets: [
      {
        name: 'kiosk',
        platform: 'kiosk',
        engine: createFakeEngine().engine,
        app: {
          url: `http://127.0.0.1:${port}`,
          command: {
            executable: process.execPath,
            args: ['server.cjs'],
            shutdownTimeout: 2000,
            env: ({ services }) => {
              log('env');

              if (failing === 'env') {
                throw new Error('env is down');
              }

              return { PORT: String(port), ALPHA_URL: (services['alpha'] as { url: string }).url };
            },
          },
        },
      },
    ],
  };
}

/** A JSON-RPC message from `e2e mcp`: the answer to the request with `id`, or a notification without one. */
type McpMessage = { readonly id?: number; readonly result?: { readonly isError?: boolean; readonly content: readonly { readonly text: string }[] } };

/** The lines of `events.log` in the project. */
const eventLines = (project: Pick<FixtureProject, 'dir'>): string[] => readFileSync(path.join(project.dir, 'events.log'), 'utf8').trim().split('\n');

const PASSING_TEST = `import { test } from 'e2e';
test('passes', async () => {});
`;

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
      'env',
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

  it('calls an env function once, after the services start, with {port} expanded', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const seen: unknown[] = [];
    const notices: string[] = [];

    const outcome = await runExisting(project, {
      runOptions: {
        onEvent: (event: RunEvent) => {
          if (event.type === 'notice') {
            notices.push(event.message);
          }
        },
      },
      config: {
        services: {
          alpha: defineService({
            async *start() {
              yield { url: 'http://alpha.test' };
            },
          }),
        },
        targets: [
          commandTarget(({ services }) => {
            seen.push(services);
            return { PORT: '{port}', ALPHA_URL: (services['alpha'] as { url: string }).url };
          }),
        ],
      },
    });

    expect(seen).toEqual([{ alpha: { url: 'http://alpha.test' } }]);
    expect(readFileSync(path.join(project.dir, 'events.log'), 'utf8')).toBe(`app start ${outcome.config?.ports['fake']} http://alpha.test\napp stop\n`);
    expect(runErrors(outcome)).toEqual([]);
    // The runner started the app itself, so it got the variables and there's nothing to warn about.
    expect(notices.filter((notice) => notice.includes("didn't get the variables"))).toEqual([]);
  });

  it.each([
    { returned: () => ({ PORT: 4000 }), message: 'target "fake" app.command.env.PORT must be a string, got' },
    { returned: () => 'PORT=4000', message: 'target "fake" app.command.env must return an object of variable names to strings, like { PORT: \'3000\' }, got a string' },
    { returned: () => new Map([['PORT', '4000']]), message: 'target "fake" app.command.env must return an object of variable names to strings, like { PORT: \'3000\' }, got an object' },
    {
      returned: () => {
        throw new Error('no port today');
      },
      message: 'target "fake" app.command.env threw: no port today',
    },
  ])('fails the run before spawning when an env function returns $message', async ({ returned, message }) => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    // @ts-expect-error -- each case returns what the env type refuses, so the runner's own check is what fails the run.
    const outcome = await runExisting(project, { config: { targets: [commandTarget(returned)] } });

    expect(runErrors(outcome)).toEqual([{ code: 'INVALID_CONFIG', message: expect.stringContaining(message) }]);
    expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
  });

  it('keeps the code of an error an env function throws with one', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const outcome = await runExisting(project, {
      config: {
        targets: [
          commandTarget(() => {
            throw new InfrastructureError('APP_UNREACHABLE', 'the database is down');
          }),
        ],
      },
    });

    expect(runErrors(outcome)).toEqual([{ code: 'APP_UNREACHABLE', message: 'the database is down' }]);
  });

  it('fails the run as a config error when an env function passes a service a value it cannot copy', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const outcome = await runExisting(project, {
      config: {
        services: {
          alpha: defineService({
            async *start() {
              yield { take: (value: string) => value };
            },
          }),
        },
        targets: [
          commandTarget(async ({ services }) => {
            const alpha = services['alpha'] as { take(value: unknown): Promise<string> };
            return { PORT: '{port}', ALPHA: await alpha.take(() => 'not data') };
          }),
        ],
      },
    });

    expect(runErrors(outcome)).toEqual([{ code: 'INVALID_CONFIG', message: expect.stringContaining('target "fake" app.command.env threw: services.alpha.take()') }]);
    expect(outcome.exitCode).toBe(2);
  });

  it.each([
    { order: 'the long budget first', names: ['long', 'short'] },
    { order: 'the short budget first', names: ['short', 'long'] },
  ])('holds each target that shares an env function to its own startupTimeout, with $order', async ({ names }) => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const env = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { PORT: '{port}' };
    };

    const target = (name: string) => ({ ...commandTarget(env, { startupTimeout: name === 'long' ? 5000 : 100 }), name });

    const outcome = await runExisting(project, { config: { targets: names.map(target) } });

    expect(runErrors(outcome)).toEqual([{ code: 'APP_UNREACHABLE', message: 'target "short" app.command.env didn\'t return within 100 ms' }]);
  });

  it('calls an env function that two targets share once, and starts one process when it returns the same variables', async () => {
    const port = await freePort();
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    let calls = 0;

    const command = {
      executable: process.execPath,
      args: ['server.cjs'],
      shutdownTimeout: 2000,
      env: () => {
        calls += 1;
        return { PORT: String(port), ALPHA_URL: 'shared' };
      },
    };

    const outcome = await runExisting(project, {
      config: {
        targets: [
          { name: 'a', platform: 'fake', engine: createFakeEngine().engine, app: { url: `http://127.0.0.1:${port}`, command } },
          { name: 'b', platform: 'fake', engine: createFakeEngine().engine, app: { url: `http://127.0.0.1:${port}`, command } },
        ],
      },
    });

    expect(calls).toBe(1);
    expect(readFileSync(path.join(project.dir, 'events.log'), 'utf8')).toBe(`app start ${port} shared\napp stop\n`);
    expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
  });

  it('starts one process for each set of variables the env functions return', async () => {
    const ports = [await freePort(), await freePort()];
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const target = (name: string, port: number) => ({
      name,
      platform: 'fake',
      engine: createFakeEngine().engine,
      app: {
        readyUrl: `http://127.0.0.1:${port}`,
        command: { executable: process.execPath, args: ['server.cjs'], shutdownTimeout: 2000, env: () => ({ PORT: String(port), ALPHA_URL: name }) },
      },
    });

    const outcome = await runExisting(project, { config: { targets: ports.map((port, index) => target(`t${index}`, port)) } });

    expect(eventLines(project).toSorted()).toEqual([`app start ${ports[0]} t0`, `app start ${ports[1]} t1`, 'app stop', 'app stop'].toSorted());
    expect(outcome.results.map((result) => result.status)).toEqual(['passed', 'passed']);
  });

  it('calls an env function when reuseExisting uses a process that is already running', async () => {
    const port = await freePort();
    const server = createServer((_request, response) => response.end('ready')).listen(port, '127.0.0.1');

    await once(server, 'listening');

    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    let calls = 0;
    const notices: string[] = [];

    try {
      const outcome = await runExisting(project, {
        runOptions: {
          onEvent: (event: RunEvent) => {
            if (event.type === 'notice') {
              notices.push(event.message);
            }
          },
        },
        config: {
          targets: [
            {
              name: 'fake',
              platform: 'fake',
              engine: createFakeEngine().engine,
              app: {
                url: `http://127.0.0.1:${port}`,
                command: {
                  executable: process.execPath,
                  args: ['server.cjs'],
                  reuseExisting: true,
                  env: () => {
                    calls += 1;
                    return { PORT: String(port) };
                  },
                },
              },
            },
          ],
        },
      });

      expect(outcome.results.map((result) => result.status)).toEqual(['passed']);
      expect(calls).toBe(1);
      expect(existsSync(path.join(project.dir, 'events.log'))).toBe(false);
      expect(notices.filter((notice) => notice.includes("didn't get the variables from the target's env function"))).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('drops an undefined value an env function returns, so the app keeps the variable it inherits', async () => {
    const project = createProject({ 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST });

    projects.push(project);

    const outcome = await runExisting(project, {
      config: {
        targets: [
          // @ts-expect-error -- the type takes strings only on purpose, so a TypeScript config handles an unset variable itself. The runner still drops an undefined value, so a JavaScript config that reads process.env keeps working.
          commandTarget(() => ({ PORT: '{port}', ALPHA_URL: undefined }), { inheritEnv: ['ALPHA_URL'] }),
        ],
      },
      runOptions: { env: { ...process.env, CI: '', ALPHA_URL: 'inherited' } },
    });

    expect(runErrors(outcome)).toEqual([]);
    expect(eventLines(project)).toEqual([`app start ${outcome.config?.ports['fake']} inherited`, 'app stop']);
  });

  it('fails with APP_UNREACHABLE when an env function does not return within startupTimeout, and stops the services', async () => {
    const events: string[] = [];

    const outcome = await runInProcess(
      { 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          alpha: defineService({
            async *start() {
              yield {};
              events.push('stop alpha');
            },
          }),
        },
        targets: [commandTarget(() => new Promise(() => undefined), { startupTimeout: 200 })],
      },
    );

    expect(runErrors(outcome)).toEqual([{ code: 'APP_UNREACHABLE', message: 'target "fake" app.command.env didn\'t return within 200 ms' }]);
    expect(events).toEqual(['stop alpha']);
    expect(outcome.results.some((result) => result.status === 'passed')).toBe(false);
  });

  it('stops waiting for an env function and stops the services when the run is interrupted', async () => {
    const interrupt = new AbortController();
    const events: string[] = [];

    const outcome = await runInProcess(
      { 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          alpha: defineService({
            async *start() {
              yield {};
              events.push('stop alpha');
            },
          }),
        },
        targets: [
          commandTarget(() => {
            interrupt.abort();
            return new Promise(() => undefined);
          }),
        ],
      },
      { interruptSignal: interrupt.signal },
    );

    expect(outcome.status).toBe('interrupted');
    expect(runErrors(outcome)).toEqual([]);
    expect(events).toEqual(['stop alpha']);
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
      { 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST },
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
        targets: [
          commandTarget(() => {
            interrupt.abort();
            return {};
          }),
        ],
      },
      { interruptSignal: interrupt.signal, forceSignal: force.signal },
    );

    expect(runErrors(outcome)).toEqual([]);
    expect(events).toEqual(['stop second']);
  });

  it('runs the stop code with the signal live after a first Ctrl+C', async () => {
    const interrupt = new AbortController();
    const aborted: boolean[] = [];

    const outcome = await runInProcess(
      { 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST },
      {
        services: {
          alpha: defineService({
            async *start({ signal }) {
              yield {};
              aborted.push(signal.aborted);
            },
          }),
        },
        targets: [
          commandTarget(() => {
            interrupt.abort();
            return {};
          }),
        ],
      },
      { interruptSignal: interrupt.signal },
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
      { 'server.cjs': SERVER, 'tests/a.e2e.ts': PASSING_TEST },
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
        targets: [
          commandTarget(() => {
            interrupt.abort();
            return {};
          }),
        ],
      },
      { interruptSignal: interrupt.signal, forceSignal: force.signal },
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

  it('lists tests without starting a service or calling an env function', async () => {
    let started = false;
    let called = false;

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
        targets: [
          commandTarget(() => {
            called = true;
            return {};
          }),
        ],
      },
    });

    projects.push(project);

    expect(pairs.map((pair) => pair.title)).toEqual(['passes']);
    expect(started).toBe(false);
    expect(called).toBe(false);
  });

  it('keeps the config digest, and with it the replay cache, when services or an env function are added', () => {
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
    expect(digest({ targets: [{ name: 'fake', platform: 'fake', engine, app: { ...app, command: { ...app.command, env: () => ({}) } } }] })).toBe(plain);
  });

  it('refuses an engine fixture named services', () => {
    expect(() => defineEngine({ name: 'shadow', version: '1.0.0', spiVersion: 1, platform: 'shadow', fixtures: { services: () => ({}) } })).toThrow(
      'fixture name "services" shadows a universal fixture',
    );
  });

  describe('openHost', () => {
    const harness = hostHarness();

    it('starts services before the app command, hands them to a session, and stops the app and then the services at close', async () => {
      const port = await freePort();

      writeFileSync(path.join(harness.dir(), 'server.cjs'), SERVER);

      const host = await harness.host(createFakeEngine().engine, { config: loggingConfig(harness.dir(), port) });
      const appStart = `app start ${port} http://alpha.test`;

      expect(eventLines({ dir: harness.dir() })).toEqual(['start alpha', 'start beta', 'env', appStart]);

      const session = await host.openSession({ name: 'reads a service' });
      const alpha = session.fixtures.services['alpha'] as { url: string; record(what: string): Promise<number> };

      expect(alpha.url).toBe('http://alpha.test');
      expect(await alpha.record('from the session')).toBe('from the session'.length);
      expect(await session.close()).toEqual([]);

      expect(await host.close()).toEqual([]);
      expect(eventLines({ dir: harness.dir() })).toEqual([
        'start alpha',
        'start beta',
        'env',
        appStart,
        'alpha record from the session',
        'app stop',
        'stop beta',
        'stop alpha',
      ]);
    });

    it('lets a service read credentials and secrets while it starts and while it stops', async () => {
      const engine = createFakeEngine().engine;
      const reads: string[] = [];

      const host = await harness.host(engine, {
        config: harness.config(engine, {
          credentials: { admin: { username: 'ada', password: 'admin-password-1' } },
          secrets: { apiKey: 'api-key-value-1' },
          services: {
            inbox: defineService({
              async *start() {
                reads.push(`start ${credentials.user('admin').username} ${secrets.get('apiKey').name}`);
                yield {};
                reads.push(`stop ${credentials.user('admin').username} ${secrets.get('apiKey').name}`);
              },
            }),
          },
        }),
      });

      expect(await host.close()).toEqual([]);
      expect(reads).toEqual(['start ada apiKey', 'stop ada apiKey']);
    });

    it('returns the same result when close is called twice, and stops each service once', async () => {
      const engine = createFakeEngine().engine;
      const stops: string[] = [];

      const host = await harness.host(engine, {
        config: harness.config(engine, {
          services: {
            inbox: defineService({
              async *start() {
                yield {};
                stops.push('stop inbox');
                throw new Error('could not flush the inbox');
              },
            }),
          },
        }),
      });

      const first = await host.close();
      const second = await host.close();

      expect(first).toEqual([expect.objectContaining({ code: 'SERVICE_STOP_FAILED', message: 'service "inbox" failed to stop: could not flush the inbox', phase: 'cleanup' })]);
      expect(second).toBe(first);
      expect(stops).toEqual(['stop inbox']);
    });

    it.each([
      {
        failing: 'beta',
        error: { code: 'SERVICE_START_FAILED', message: 'service "beta" failed to start: beta is down' },
        events: ['start alpha', 'start beta', 'stop alpha'],
      },
      {
        failing: 'env',
        error: { code: 'INVALID_CONFIG', message: 'target "kiosk" app.command.env threw: env is down' },
        events: ['start alpha', 'start beta', 'env', 'stop beta', 'stop alpha'],
      },
    ])('stops the services that started when the host fails to open because $error.message', async ({ failing, error, events }) => {
      const port = await freePort();

      writeFileSync(path.join(harness.dir(), 'server.cjs'), SERVER);

      await expect(harness.host(createFakeEngine().engine, { config: loggingConfig(harness.dir(), port, failing) })).rejects.toMatchObject(error);

      expect(eventLines({ dir: harness.dir() })).toEqual(events);

      const reopened = await harness.host(createFakeEngine().engine, { config: harness.config(createFakeEngine().engine) });

      expect(await reopened.close()).toEqual([]);
    });
  });

  describe('e2e mcp', () => {
    /** A project with `SERVER` and `files`, and a session host whose sessions load `loggingConfig` fresh from it, as a config file loads. */
    function mcpProject(port: number, files: Readonly<Record<string, string>> = {}, failing?: string) {
      const project = createProject({ 'server.cjs': SERVER, ...files });

      projects.push(project);

      const host = new SessionHost({
        locateConfig: () => path.join(project.dir, 'e2e.config.ts'),
        loadConfig: async (configPath) => ({ ...resolveConfig(loggingConfig(project.dir, port, failing), { projectRoot: project.dir, env: {}, configPath }), configPath }),
        loadEngineConfig: async () => {
          throw new Error('no engine sessions here');
        },
        env: {},
        headed: false,
        log: () => undefined,
        maxSessions: 2,
      });

      return { project, host };
    }

    /** The id an opening text names. */
    const sessionId = (opening: string): string => /^Session (\S+) open/.exec(opening)?.[1] ?? '';

    it('starts services with the first session on a config file, shares them with the next, and stops them after the last one closes', async () => {
      const port = await freePort();
      const { project, host } = mcpProject(port);

      const first = await host.open({});
      const appStart = `app start ${port} http://alpha.test`;

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'env', appStart]);
      expect(first).toContain('Services: alpha, beta.');

      const second = await host.open({});

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'env', appStart, 'env']);

      await host.close('done', sessionId(first));

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'env', appStart, 'env']);

      await host.close('done', sessionId(second));

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'env', appStart, 'env', 'app stop', 'stop beta', 'stop alpha']);
    });

    it('hands the services to an env function and to a test that open_session runs', async () => {
      const port = await freePort();

      const { project, host } = mcpProject(port, {
        'tests/reads.e2e.ts': `import { test } from 'e2e';
test('reads a service', async ({ services }) => {
  const alpha = services['alpha'] as { url: string; record(what: string): Promise<number> };
  if (alpha.url !== 'http://alpha.test') {
    throw new Error('alpha.url is ' + alpha.url);
  }
  await alpha.record('from the test');
});
`,
      });

      const opening = await host.open({ test: 'tests/reads.e2e.ts' });

      expect(opening).toMatch(/passed/);

      await host.closeAll('done');

      expect(eventLines(project)).toEqual([
        'start alpha',
        'start beta',
        'env',
        `app start ${port} http://alpha.test`,
        'alpha record from the test',
        'app stop',
        'stop beta',
        'stop alpha',
      ]);
    });

    it('hands the services to run_code, whose function calls run in the server process', async () => {
      const port = await freePort();
      const { project, host } = mcpProject(port);

      const id = sessionId(await host.open({}));

      const result = await host.call(
        id,
        'run_code',
        { code: "return { url: services.alpha.url, recorded: await services.alpha.record('from run_code') };" },
        { signal: new AbortController().signal },
      );

      await host.closeAll('done');

      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain(String.raw`{\"url\":\"http://alpha.test\",\"recorded\":13}`);
      expect(eventLines(project)).toContain('alpha record from run_code');
    });

    it('lets a service read credentials and secrets while it starts and while it stops', async () => {
      const project = createProject({ 'server.cjs': SERVER });

      projects.push(project);

      const reads: string[] = [];

      const config: E2EConfig = {
        credentials: { admin: { username: 'ada', password: 'admin-password-1' } },
        secrets: { apiKey: 'api-key-value-1' },
        services: {
          inbox: defineService({
            async *start() {
              reads.push(`start ${credentials.user('admin').username} ${secrets.get('apiKey').name}`);
              yield {};
              reads.push(`stop ${credentials.user('admin').username} ${secrets.get('apiKey').name}`);
            },
          }),
        },
        targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine().engine, app: FAKE_APP }],
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

      await host.close('done', sessionId(await host.open({})));

      expect(reads).toEqual(['start ada apiKey', 'stop ada apiKey']);
    });

    it('starts the services again for a session that opens after the last one closed', async () => {
      const port = await freePort();
      const { project, host } = mcpProject(port);

      await host.close('done', sessionId(await host.open({})));

      const id = sessionId(await host.open({}));
      const result = await host.call(id, 'run_code', { code: "return await services.alpha.record('again');" }, { signal: new AbortController().signal });

      await host.closeAll('done');

      const appStart = `app start ${port} http://alpha.test`;

      expect(result.isError).not.toBe(true);
      expect(eventLines(project)).toEqual([
        'start alpha',
        'start beta',
        'env',
        appStart,
        'app stop',
        'stop beta',
        'stop alpha',
        'start alpha',
        'start beta',
        'env',
        appStart,
        'alpha record again',
        'app stop',
        'stop beta',
        'stop alpha',
      ]);
    });

    /** `e2e mcp` running in `dir` over stdio, with a client that sends requests and tool calls to it. */
    async function mcpServer(dir: string) {
      const server = spawn(process.execPath, [CLI, 'mcp'], { cwd: dir, env: { ...process.env, CI: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const output = { stderr: '' };

      server.stderr.on('data', (chunk: Buffer) => {
        output.stderr += chunk.toString();
      });

      const exited = new Promise<number | null>((resolve) => server.once('exit', resolve));
      const replies = new Map<number, (message: McpMessage) => void>();

      let buffered = '';

      server.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();

        const lines = buffered.split('\n');

        buffered = lines.pop() ?? '';

        for (const line of lines) {
          const message = JSON.parse(line) as McpMessage;

          if (message.id !== undefined) {
            replies.get(message.id)?.(message);
          }
        }
      });

      let nextId = 0;

      const request = async (method: string, params: object) => {
        nextId += 1;

        const reply = new Promise<McpMessage>((resolve) => replies.set(nextId, resolve));

        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);

        return reply;
      };

      const callTool = async (name: string, args: object): Promise<string> => {
        const reply = await request('tools/call', { name, arguments: args });
        const text = reply.result?.content.map((part) => part.text).join('\n') ?? '';

        expect(reply.result?.isError, `${text}\n${output.stderr}`).not.toBe(true);

        return text;
      };

      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'services', version: '0.0.0' } });

      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      return { server, output, exited, request, callTool };
    }

    it('stops the app and then the services when the client closes stdin with sessions open, and leaves no process behind', async () => {
      const port = await freePort();

      const project = createProject({
        'services.ts': SERVICES,
        'server.cjs': SERVER,
        'e2e.config.ts': CONFIG.replace("url: 'http://127.0.0.1:0'", `url: 'http://127.0.0.1:${port}'`),
      });

      projects.push(project);

      const { server, output, exited, callTool } = await mcpServer(project.dir);

      try {
        const first = sessionId(await callTool('open_session', {}));

        await callTool('open_session', {});

        expect(await callTool('call', { session: first, tool: 'run_code', args: { code: "return await services.alpha.record('over stdio');" } })).toContain('10');

        server.stdin.end();

        expect(await Promise.race([exited, sleep(20_000).then(() => 'running')]), output.stderr).toBe(0);
      } finally {
        if (server.exitCode === null) {
          server.kill('SIGKILL');
        }
      }

      const appStart = `app start ${port} http://alpha.test`;

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'env', appStart, 'env', 'alpha record over stdio', 'app stop', 'stop beta', 'stop alpha']);
      await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
    });

    it('finishes stopping the services that started before it exits, when the client closes stdin while a service is still starting', async () => {
      const project = createProject({
        'services.ts': `import { appendFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { defineService } from 'e2e';

const log = (line: string) => appendFileSync(new URL('./events.log', import.meta.url), line + '\\n');

export const alpha = defineService({
  async *start() {
    log('start alpha');
    yield { url: 'http://alpha.test' };
    // Longer than the CLI waits for leftover work after the command returns.
    await sleep(3000);
    log('stop alpha');
  },
});

export const beta = defineService({
  async *start({ signal }) {
    log('start beta');
    await sleep(60_000, undefined, { signal });
    yield {};
  },
});
`,
        'server.cjs': SERVER,
        'e2e.config.ts': CONFIG.replace("import { logged } from './services.ts';", "import { alpha, beta } from './services.ts';").replace("services: { alpha: logged('alpha'), beta: logged('beta') },", 'services: { alpha, beta },'),
      });

      projects.push(project);

      const { server, output, exited, request } = await mcpServer(project.dir);

      try {
        void request('tools/call', { name: 'open_session', arguments: {} });

        await expect.poll(() => (existsSync(path.join(project.dir, 'events.log')) ? eventLines(project) : []), { timeout: 20_000 }).toEqual(['start alpha', 'start beta']);

        server.stdin.end();

        expect(await Promise.race([exited, sleep(20_000).then(() => 'running')]), output.stderr).toBe(0);
      } finally {
        if (server.exitCode === null) {
          server.kill('SIGKILL');
        }
      }

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'stop alpha']);
    });

    it('fails open_session with SERVICE_START_FAILED when a service fails to start, and leaves nothing running', async () => {
      const port = await freePort();
      const { project, host } = mcpProject(port, {}, 'beta');

      await expect(host.open({})).rejects.toMatchObject({ code: 'SERVICE_START_FAILED', message: 'service "beta" failed to start: beta is down' });

      expect(eventLines(project)).toEqual(['start alpha', 'start beta', 'stop alpha']);
      expect(host.isOpen).toBe(false);
    });
  });
});

