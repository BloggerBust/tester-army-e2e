import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  connectEngine,
  defineEngine,
  describeEngine,
  ENGINE_METHODS,
  KNOWN_LOCATOR_ACTION_KINDS,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  EngineError,
  loopbackTransport,
  spawnTransport,
  TestError,
  type Engine,
  type EngineAttemptContext,
  type EngineHandle,
  type EngineInitInfo,
  type OperationContext,
  type SemanticNode,
} from '@e2e-dev/core/lib/engine/index';
import { resolveConfig } from '../../src/config/resolve-run.ts';
import { engineAppInfo } from '@e2e-dev/core/lib/config/app';
import { ConfigurationError, TestTimeoutError } from '@e2e-dev/core/lib/internal/errors';
import { encodeLocatorAction, decodeLocatorAction } from '@e2e-dev/core/lib/engine/protocol/protocol';
import { protocolEngine } from '@e2e-dev/core/lib/engine/protocol/client';
import { Connection } from '@e2e-dev/core/lib/engine/protocol/connection';
import type { EngineTransport } from '@e2e-dev/core/lib/engine/protocol/transport';
import { secretHandle } from '@e2e-dev/core/lib/secrets';
import type { CrashMode } from '../fixtures/protocol-server.ts';

const node = (id: string, name: string, role = 'button'): SemanticNode => ({ ref: { id, revision: '' }, role, name });

const ROOT: SemanticNode = { ref: { id: 'root', revision: '' }, role: 'root', children: [node('n1', 'Save'), node('n2', 'Cancel')] };

const operation = (signal: AbortSignal = new AbortController().signal): OperationContext => ({
  signal,
  timeoutMs: 1000,
  runId: 'run',
  attemptId: 'attempt-1',
  origin: 'test',
});

const initInfo = (log: (line: string) => void = () => {}): EngineInitInfo => ({
  runId: 'run',
  targetName: 'toy',
  projectRoot: process.cwd(),
  app: {},
  env: process.env,
  headed: false,
  workerSlot: 0,
  signal: new AbortController().signal,
  log,
});

const cleanup = { signal: new AbortController().signal, timeoutMs: 1000 };

/** Serves `engine` in this process and returns the client handle over it. */
function overLoopback(engine: Engine, extra: Partial<Parameters<typeof connectEngine>[0]> = {}): { local: EngineHandle; remote: EngineHandle } {
  const local = defineEngine(engine);
  return { local, remote: connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local), ...extra }) };
}

const toy = (extra: Partial<Engine> = {}): Engine => ({
  name: 'toy',
  version: '1.0.0',
  spiVersion: 1,
  observe: async () => ({ root: ROOT, viewport: { width: 1280, height: 720 } }),
  ...extra,
});

describe('engine protocol', () => {
  it('carries a read request and computed values through JSON-RPC', async () => {
    const read = vi.fn(async () => ({ color: 'rgb(255, 0, 0)' }));
    const { remote } = overLoopback(toy({ readStyle: read }));
    expect(remote.capabilities.has('computed-style')).toBe(true);
    await remote.init!(initInfo());
    const ref = { id: 'n1', revision: '1' };
    await expect(remote.readStyle!(ref, ['color'], operation())).resolves.toEqual({ color: 'rgb(255, 0, 0)' });
    expect(read).toHaveBeenCalledExactlyOnceWith(ref, ['color'], expect.objectContaining({ origin: 'test' }));
    await remote.dispose!(cleanup);
    expect(() => defineEngine({ name: 'bad', version: '1', spiVersion: 1, readStyle: read })).toThrow(/readStyle without observe/);
  });
  it('declares the same capabilities over the protocol as the engine itself', () => {
    const { local, remote } = overLoopback(
      toy({
        actions: ['tap', 'fill'],
        perform: async () => {},
        keyboard: { type: async () => {}, press: async () => {} },
        session: { open: async () => {}, reset: async () => {} },
      }),
    );
    expect([...remote.capabilities].toSorted()).toEqual([...local.capabilities].toSorted());
    expect(remote.actions).toEqual(['tap', 'fill']);
    expect(Object.keys(remote.session ?? {}).toSorted()).toEqual(['open', 'reset']);
  });

  it('encodes only wire payload bytes and keeps ordinary path actions unchanged', () => {
    const bytes = new Uint8Array([17, 0, 128, 255, 18]).subarray(1, 4);
    const action = { kind: 'setInputFilePayloads', files: [
      { name: 'a.bin', mimeType: 'application/octet-stream', buffer: bytes },
      { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: new Uint8Array() },
    ] } as const;
    const wire = encodeLocatorAction(action);
    expect(wire).toEqual({ kind: 'setInputFilePayloads', files: [
      { name: 'a.bin', mimeType: 'application/octet-stream', buffer: 'AID/' },
      { name: 'empty.bin', mimeType: 'application/octet-stream', buffer: '' },
    ] });
    expect(decodeLocatorAction(JSON.parse(JSON.stringify(wire)))).toEqual(action);
    const paths = { kind: 'setInputFiles', paths: ['a.bin'] } as const;
    expect(encodeLocatorAction(paths)).toBe(paths);
    expect(decodeLocatorAction(paths)).toBe(paths);
  });

  it('negotiates payload uploads and preserves their bytes over JSON-RPC', async () => {
    const perform = vi.fn<NonNullable<Engine['perform']>>(async () => undefined);
    const { local, remote } = overLoopback(toy({ actions: KNOWN_LOCATOR_ACTION_KINDS, perform }));
    expect(remote.actions).toContain('setInputFilePayloads');
    await remote.init!(initInfo());
    const action = { kind: 'setInputFilePayloads', files: [{ name: 'binary.bin', mimeType: 'application/octet-stream', buffer: new Uint8Array([0, 128, 255]) }] } as const;
    await local.perform!({ id: 'root', revision: '1' }, action, operation());
    expect(perform.mock.calls[0]?.[1]).toBe(action);
    perform.mockClear();
    await remote.perform!({ id: 'root', revision: '1' }, action, operation());
    expect(perform).toHaveBeenCalledWith(expect.anything(), action, expect.anything());
    await remote.dispose!(cleanup);
    const legacy = overLoopback(toy({ actions: LOCATOR_ACTION_KINDS, perform }));
    expect(legacy.remote.actions).not.toContain('setInputFilePayloads');
  });

  it('advertises multiTap and carries its count and modifiers over JSON-RPC unchanged', async () => {
    const perform = vi.fn<NonNullable<Engine['perform']>>(async () => undefined);
    const { remote } = overLoopback(toy({ actions: ['tap', 'multiTap'], perform }));
    expect(remote.actions).toContain('multiTap');
    await remote.init!(initInfo());
    const action = { kind: 'multiTap', count: 3, modifiers: ['Shift'] } as const;
    await remote.perform!({ id: 'root', revision: '1' }, action, operation());
    expect(perform).toHaveBeenCalledWith(expect.anything(), action, expect.anything());
    await remote.dispose!(cleanup);
  });

  it('carries a snapshot with its pixels byte for byte', async () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 7]);
    const { remote } = overLoopback(
      toy({
        observe: async () => ({ root: ROOT, viewport: { width: 10, height: 10 }, pixels: { data, mediaType: 'image/png', width: 20, height: 20, scale: 2 } }),
      }),
    );
    await remote.init!(initInfo());
    const snapshot = await remote.observe!(operation());
    expect(snapshot.root).toEqual(ROOT);
    expect(snapshot.pixels?.data).toEqual(data);
    expect(snapshot.pixels?.scale).toBe(2);
    await remote.dispose!(cleanup);
  });

  it('rethrows an engine error with its code and retryability, and a harness error with its category', async () => {
    let throwing: unknown;
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async () => {
          throw throwing;
        },
      }),
    );
    await remote.init!(initInfo());
    const ref = { id: 'n1', revision: '' };
    throwing = new EngineError('NODE_STALE', 'gone', { retryable: true });
    await expect(remote.perform!(ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ name: 'EngineError', code: 'NODE_STALE', retryable: true, message: 'gone' });
    throwing = new TestError('ACTION_FAILED', 'blocked', { details: { locator: 'x' } });
    await expect(remote.perform!(ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ category: 'test', code: 'ACTION_FAILED', details: { locator: 'x' } });
    throwing = new Error('plain');
    const plain = await remote.perform!(ref, { kind: 'tap' }, operation()).catch((cause: unknown) => cause);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(EngineError);
    expect((plain as Error).message).toBe('plain');
    await remote.dispose!(cleanup);
  });

  it('keeps a thrown error\'s stack and causes across the protocol', async () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const thrown = new Error('fetch failed', { cause: inner });
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async () => {
          throw thrown;
        },
      }),
    );
    await remote.init!(initInfo());
    const received = (await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation()).catch((cause: unknown) => cause)) as Error;
    expect(received.stack).toBe(thrown.stack);
    expect(received.cause).toMatchObject({ message: 'connect ECONNREFUSED', code: 'ECONNREFUSED', stack: inner.stack });
    await remote.dispose!(cleanup);
  });

  it('detaches from a caller\'s signal once the connection closes', async () => {
    const live = new AbortController().signal;
    const { remote } = overLoopback(toy());
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await remote.init!({ ...initInfo(), signal: live });
      await remote.observe!(operation(live));
      await remote.dispose!(cleanup);
    }
    expect(getEventListeners(live, 'abort')).toHaveLength(0);
  });

  it('aborts the server-side signal when the client aborts, including one already aborted', async () => {
    const seen: AbortSignal[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          seen.push(context.signal);
          if (context.signal.aborted) return;
          await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
        },
      }),
    );
    await remote.init!(initInfo());
    const controller = new AbortController();
    const pending = remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await pending;
    expect(seen[0]?.aborted).toBe(true);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    expect(seen[1]?.aborted).toBe(true);
    await remote.dispose!(cleanup);
  });

  it('carries the abort reason, so an engine rethrowing it raises what it would in process', async () => {
    const reasons: unknown[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          if (!context.signal.aborted) await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }));
          reasons.push(context.signal.reason);
        },
      }),
    );
    await remote.init!(initInfo());
    const controller = new AbortController();
    const pending = remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new TestTimeoutError('test timed out after 1000ms'));
    await pending;
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(controller.signal));
    const bare = new AbortController();
    bare.abort();
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(bare.signal));
    expect(reasons[0]).toMatchObject({ category: 'test', code: 'TEST_TIMEOUT', message: 'test timed out after 1000ms' });
    expect(reasons[1]).toMatchObject({ category: 'test', code: 'TEST_TIMEOUT' });
    expect((reasons[2] as Error).name).toBe('AbortError');
    await remote.dispose!(cleanup);
  });

  it('refuses a call before init instead of opening a connection on its own', async () => {
    const { remote } = overLoopback(toy());
    await expect(remote.observe!(operation())).rejects.toMatchObject({ name: 'EngineError', code: 'INVALID_STATE' });
  });

  it('serves a second init on its own connection and disposes the oldest first, as a handover between sessions does', async () => {
    const slots: number[] = [];
    const { remote } = overLoopback(
      toy({
        init: async (info) => {
          slots.push(info.workerSlot);
        },
        dispose: async () => {},
      }),
    );
    await remote.init!(initInfo());
    await remote.init!({ ...initInfo(), workerSlot: 1 });
    await remote.dispose!(cleanup);
    await expect(remote.observe!(operation())).resolves.toMatchObject({ root: ROOT });
    await remote.dispose!(cleanup);
    await expect(remote.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(slots).toEqual([0, 1]);
  });

  it('keeps one signal per id within an attempt and forgets the attempt\'s signals when it ends', async () => {
    const seen: AbortSignal[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          seen.push(context.signal);
        },
        startAttempt: async () => {},
        endAttempt: async () => {},
      }),
    );
    const attempt: EngineAttemptContext = { attemptId: 'attempt-1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} };
    const signal = new AbortController().signal;
    await remote.init!(initInfo());
    await remote.startAttempt!(attempt);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(signal));
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(signal));
    await remote.endAttempt!(cleanup);
    await remote.startAttempt!({ ...attempt, attemptId: 'attempt-2' });
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(signal));
    await remote.endAttempt!(cleanup);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
    await remote.dispose!(cleanup);
  });

  it('forgets an attempt\'s signals for an engine without attempt hooks', async () => {
    const seen: AbortSignal[] = [];
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async (_ref, _action, context) => {
          seen.push(context.signal);
        },
      }),
    );
    const attempt: EngineAttemptContext = { attemptId: 'attempt-1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} };
    const signal = new AbortController().signal;
    await remote.init!(initInfo());
    await remote.startAttempt!(attempt);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(signal));
    await remote.endAttempt!(cleanup);
    await remote.startAttempt!({ ...attempt, attemptId: 'attempt-2' });
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation(signal));
    await remote.endAttempt!(cleanup);
    expect(seen[1]).not.toBe(seen[0]);
    await remote.dispose!(cleanup);
  });

  it('keeps the next attempt when the previous attempt\'s endAttempt settles late', async () => {
    let release: (() => void) | undefined;
    let current: EngineAttemptContext | undefined;
    const { remote } = overLoopback(
      toy({
        actions: ['tap'],
        perform: async () => {
          current?.environment({ attempt: current.attemptId });
        },
        startAttempt: async (context) => {
          current = context;
        },
        endAttempt: async () => {
          if (current?.attemptId === 'attempt-1') await new Promise<void>((resolve) => (release = resolve));
        },
      }),
    );
    const facts: Record<string, string>[] = [];
    const attempt = (attemptId: string): EngineAttemptContext => ({
      attemptId,
      artifactsDir: tmpdir(),
      signal: new AbortController().signal,
      resolveSecret: async () => '',
      appLog: () => {},
      navigation: () => {},
      environment: (entry) => facts.push({ ...entry }),
    });
    await remote.init!(initInfo());
    await remote.startAttempt!(attempt('attempt-1'));
    const late = remote.endAttempt!(cleanup);
    await vi.waitFor(() => expect(release).toBeDefined());
    await remote.startAttempt!(attempt('attempt-2'));
    release?.();
    await late;
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation());
    expect(facts).toEqual([{ attempt: 'attempt-2' }]);
    await remote.dispose!(cleanup);
  });

  it('prepares and finishes each target that shares one handle on its own connection', async () => {
    const finished: string[] = [];
    const { remote } = overLoopback(
      toy({
        async prepare() {},
        async finish(info) {
          finished.push(info.targetName);
        },
      }),
    );
    const prepare = (targetName: string) =>
      remote.prepare!({ runId: 'run', targetName, projectRoot: process.cwd(), app: {}, slots: 1, env: {}, headed: false, signal: new AbortController().signal, log: () => {} });
    await prepare('a');
    await prepare('b');
    const finish = (targetName: string) => remote.finish!({ runId: 'run', targetName, env: {}, log: () => {}, ...cleanup });
    await Promise.all([finish('a'), finish('b')]);
    expect(finished.toSorted()).toEqual(['a', 'b']);
  });

  it('routes attempt callbacks and secret resolution back to the harness', async () => {
    const secret = secretHandle({ name: 'password', purpose: 'generic-secret' });
    const { remote } = overLoopback(
      toy({
        secrets: [secret],
        async startAttempt(context) {
          context.appLog({ source: 'console', level: 'info', text: 'hello' });
          context.navigation('navigated to /home');
          context.environment({ device: 'toy' });
          context.screen?.({ root: ROOT, viewport: { width: 1, height: 1 } });
          const value = await context.resolveSecret(secret, { derived: (plain) => [`b64:${plain}`] });
          context.appLog({ source: 'system', level: 'info', text: `resolved ${value.length}` });
        },
        async endAttempt() {},
      }),
      { secrets: [secret] },
    );
    const received: string[] = [];
    const resolved: { name: string; derived?: readonly string[] }[] = [];
    const context: EngineAttemptContext = {
      attemptId: 'attempt-1',
      artifactsDir: '/tmp',
      signal: new AbortController().signal,
      resolveSecret: async (handle, options) => {
        resolved.push({ name: handle.name, ...(options?.derived === undefined ? {} : { derived: await options.derived('hunter22') }) });
        return 'hunter22';
      },
      appLog: (entry) => received.push(`log:${entry.text}`),
      navigation: (line) => received.push(`nav:${line}`),
      environment: (facts) => received.push(`env:${JSON.stringify(facts)}`),
      screen: (snapshot) => received.push(`screen:${snapshot.root.ref.id}`),
    };
    await remote.init!(initInfo());
    await remote.startAttempt!(context);
    await remote.endAttempt!(cleanup);
    expect(received).toEqual(['log:hello', 'nav:navigated to /home', 'env:{"device":"toy"}', 'screen:root', 'log:resolved 8']);
    expect(resolved).toEqual([{ name: 'password', derived: ['b64:hunter22'] }]);
    await remote.dispose!(cleanup);
  });

  it('runs prepare and finish on a run connection and init again after dispose', async () => {
    const calls: string[] = [];
    const { remote } = overLoopback(
      toy({
        async prepare(info) {
          info.log('preparing');
          return { workers: 1, env: { TOY: '1' } };
        },
        async finish() {
          calls.push('finish');
        },
        async init(info) {
          info.log(`init ${String(info.workerSlot)}`);
        },
        async dispose() {
          calls.push('dispose');
        },
      }),
    );
    const logs: string[] = [];
    const result = await remote.prepare!({
      runId: 'run',
      targetName: 'toy',
      projectRoot: process.cwd(),
      app: {},
      slots: 1,
      env: {},
      headed: false,
      signal: new AbortController().signal,
      log: (line) => logs.push(line),
    });
    expect(result).toEqual({ workers: 1, env: { TOY: '1' } });
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.dispose!(cleanup);
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.dispose!(cleanup);
    await remote.finish!({ runId: 'run', targetName: 'toy', env: {}, log: () => {}, ...cleanup });
    expect(logs).toEqual(['preparing', 'init 0', 'init 0']);
    expect(calls).toEqual(['dispose', 'dispose', 'finish']);
  });

  it('opens a doctor connection, never one for an already aborted signal, and gives an aborted doctor its grace', async () => {
    const roles: string[] = [];
    const stopped: string[] = [];
    const local = defineEngine(
      toy({
        doctor: (info) =>
          new Promise((resolve) => {
            info.signal.addEventListener('abort', () => setTimeout(() => {
              stopped.push('stopped');
              resolve([]);
            }, 100));
          }),
      }),
    );
    const loopback = loopbackTransport(local);
    const transport: EngineTransport = {
      label: 'recording',
      open: (context) => {
        roles.push(context.role);
        return loopback.open(context);
      },
    };
    const remote = connectEngine({ manifest: describeEngine(local), transport });
    const info = (signal: AbortSignal) => ({ targetName: 'toy', projectRoot: process.cwd(), app: {}, env: {}, headed: false, signal, log: () => {} });
    await expect(remote.doctor!(info(AbortSignal.abort()))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(roles).toEqual([]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(remote.doctor!(info(controller.signal))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(roles).toEqual(['doctor']);
    expect(stopped).toEqual(['stopped']);
  });

  it('runs doctor over the protocol with its info and returns its findings', async () => {
    const seen: { targetName: string; headed: boolean; log: boolean }[] = [];
    const { remote } = overLoopback(
      toy({
        async doctor(info) {
          seen.push({ targetName: info.targetName, headed: info.headed, log: typeof info.log === 'function' });
          return [{ id: 'toolchain', status: 'warn', message: 'downloads on first run' }];
        },
      }),
    );
    const findings = await remote.doctor!({ targetName: 'toy', projectRoot: process.cwd(), app: {}, env: {}, headed: true, signal: new AbortController().signal, log: () => {} });
    expect(findings).toEqual([{ id: 'toolchain', status: 'warn', message: 'downloads on first run' }]);
    expect(seen).toEqual([{ targetName: 'toy', headed: true, log: true }]);
    expect(overLoopback(toy()).remote.doctor).toBeUndefined();
  });

  it('answers session hooks the client declares instead of the server', async () => {
    const calls: string[] = [];
    const { remote } = overLoopback(
      toy({
        session: {
          back: async () => { calls.push('server back'); },
          resize: async (size) => { calls.push(`server resize ${String(size.width)}x${String(size.height)}`); },
        },
      }),
      { session: { restart: async () => { calls.push('client restart'); } } },
    );
    await remote.init!(initInfo());
    await remote.session!.back!(operation());
    await remote.session!.resize!({ width: 390, height: 844 }, operation());
    await remote.session!.restart!(operation());
    expect(calls).toEqual(['server back', 'server resize 390x844', 'client restart']);
    await remote.dispose!(cleanup);
  });

  it('answers locators on the client from observations when asked to', async () => {
    const { remote } = overLoopback(toy(), { resolveLocators: true });
    expect(remote.capabilities.has('location')).toBe(true);
    await remote.init!(initInfo());
    const nodes = await remote.locate!({ kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'button', exact: true }, name: { kind: 'string', value: 'Cancel', exact: true } } }, operation());
    expect(nodes.map((match) => match.ref.id)).toEqual(['n2']);
    await remote.dispose!(cleanup);
  });

  it('refuses a server whose manifest differs from the declared one', async () => {
    const local = defineEngine(toy({ version: '2.0.0' }));
    const remote = connectEngine({ manifest: { ...describeEngine(local), version: '1.0.0' }, transport: loopbackTransport(local) });
    await expect(remote.init!(initInfo())).rejects.toThrow(/version is "2.0.0", declared "1.0.0"/);
  });

  it('describes an engine with a manifest the published schema accepts, and the schema names every method and kind', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../schema/engine-manifest-v1.schema.json', import.meta.url)), 'utf8')) as {
      properties: Record<string, { items?: { enum: string[] } }>;
    };
    expect(schema.properties['methods']?.items?.enum).toEqual([...ENGINE_METHODS]);
    expect(schema.properties['actions']?.items?.enum).toEqual([...KNOWN_LOCATOR_ACTION_KINDS]);
    expect(schema.properties['pointerActions']?.items?.enum).toEqual([...POINTER_ACTION_KINDS]);
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const { local } = overLoopback(
      toy({
        actions: ['tap', 'blur'],
        perform: async () => {},
        pointerActions: ['tap'],
        performAt: async () => {},
        keyboard: { type: async () => {}, press: async () => {} },
        grantsAllPermissions: true,
        init: async () => {},
      }),
    );
    expect(validate(describeEngine(local))).toBe(true);
    expect(describeEngine(local).grantsAllPermissions).toBe(true);
    expect(connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local) }).grantsAllPermissions).toBe(true);
    const base = { name: 'x', version: '1', spiVersion: 1 };
    for (const refused of [
      { ...base, methods: ['engine/observe', 'engine/teleport'] },
      { ...base, methods: ['engine/readStyle'] },
      { ...base, methods: ['engine/observe'], actions: ['tap'] },
      { ...base, methods: ['engine/observe'], actions: ['blur'] },
      { ...base, methods: ['engine/viewportIntersection'] },
      { ...base, methods: ['engine/observe'], tapModifiers: true },
      { ...base, methods: ['engine/observe'], selectsDevice: true },
      // The client serves prepare for finish alone, which would drop the device it never forwards.
      { ...base, methods: ['lifecycle/finish'], selectsDevice: true },
      { ...base, methods: ['engine/observe'], pointerActions: ['tap'] },
      { ...base, methods: ['engine/observe'], grantsAllPermissions: 'yes' },
      { ...base, methods: ['engine/locate'] },
      { ...base, methods: ['engine/observe', 'keyboard/type'] },
      { ...base, methods: ['state/capture'] },
      { ...base, methods: ['artifacts/screenshot', 'artifacts/startVideo'] },
    ]) {
      expect(validate(refused), JSON.stringify(refused)).toBe(false);
      expect(() => connectEngine({ manifest: refused as never, transport: loopbackTransport(local) }), JSON.stringify(refused)).toThrow(ConfigurationError);
    }
    // Only a worker-isolated engine names its isolation; `attempt` is the default, left out.
    expect(validate({ ...base, methods: ['engine/observe'], isolation: 'attempt' })).toBe(false);
  });

  describe('launch arguments', () => {
    const resolveTarget = (engine: EngineHandle, launchArguments: unknown) =>
      resolveConfig(
        { targets: [{ name: 'phone', platform: 'toy', engine, app: { bundleId: 'dev.shop.app', launchArguments: launchArguments as never } }] },
        { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv },
      ).targets[0]!;

    const prepare = (target: ReturnType<typeof resolveTarget>) =>
      target.engine!.prepare!({ runId: 'run', targetName: target.name, projectRoot: process.cwd(), app: engineAppInfo(target.app), slots: 1, env: {}, headed: false, signal: new AbortController().signal, log: () => {} });

    it('hands an engine that predates the object form a list it can spread, and refuses an object at config load', async () => {
      const spread: string[][] = [];
      const legacy = defineEngine(
        toy({
          validateApp(app) {
            spread.push([...(app.launchArguments ?? [])]);
          },
          async prepare(info) {
            spread.push([...(info.app.launchArguments ?? [])]);
          },
        }),
      );
      await prepare(resolveTarget(legacy, ['-AppleLocale', 'fr_FR']));
      expect(spread).toEqual([
        ['-AppleLocale', 'fr_FR'],
        ['-AppleLocale', 'fr_FR'],
      ]);

      expect(() => resolveTarget(legacy, { AppleLocale: 'fr_FR', AppleLanguages: ['fr'] })).toThrowError(
        expect.objectContaining({
          code: 'INVALID_CONFIG',
          message:
            'target "phone" app.launchArguments is an object, and engine "toy" takes only a list of strings: write the arguments as a list, or use an engine version that supports the object syntax',
        }),
      );
      expect(spread).toHaveLength(2);
    });

    it('carries fileApps in the manifest, so a served engine opens a file app and one that does not declare it is refused', () => {
      const { local, remote } = overLoopback(toy({ fileApps: true }));
      expect(describeEngine(local).fileApps).toBe(true);
      expect(remote.fileApps).toBe(true);
      const plain = overLoopback(toy({}));
      expect(describeEngine(plain.local).fileApps).toBeUndefined();
      expect(plain.remote.fileApps).not.toBe(true);
    });

    it('refuses a server that does not declare the fileApps its manifest promised', async () => {
      const local = defineEngine(toy({}));
      const remote = connectEngine({ manifest: { ...describeEngine(local), fileApps: true }, transport: loopbackTransport(local) });
      await expect(remote.init!(initInfo())).rejects.toThrow(/fileApps is false, declared true/);
    });

    it('refuses a fileApps flag that is not a boolean', () => {
      expect(() => defineEngine(toy({ fileApps: 'yes' as never }))).toThrow(/fileApps must be a boolean/);
    });

    it('carries the object form to an engine that declares launchArgumentValues', async () => {
      const seen: unknown[] = [];
      const { local, remote } = overLoopback(
        toy({
          launchArgumentValues: true,
          async prepare(info) {
            seen.push(info.app);
          },
        }),
        {
          validateApp(app) {
            seen.push(app);
          },
        },
      );
      expect(describeEngine(local).launchArgumentValues).toBe(true);
      expect(remote.launchArgumentValues).toBe(true);

      const launchArgumentValues = { AppleLocale: 'fr_FR', AppleLanguages: ['fr'], e2e: true, retries: 3 };
      await prepare(resolveTarget(remote, { ...launchArgumentValues, token: undefined }));
      expect(seen).toEqual([
        { bundleId: 'dev.shop.app', launchArgumentValues },
        { bundleId: 'dev.shop.app', launchArgumentValues },
      ]);

      seen.length = 0;
      await prepare(resolveTarget(remote, ['-e2e', 'YES']));
      expect(seen).toEqual([
        { bundleId: 'dev.shop.app', launchArguments: ['-e2e', 'YES'] },
        { bundleId: 'dev.shop.app', launchArguments: ['-e2e', 'YES'] },
      ]);
    });

    it('refuses a launchArgumentValues flag that is not a boolean', () => {
      expect(() => defineEngine(toy({ launchArgumentValues: 'yes' as never }))).toThrow(/launchArgumentValues must be a boolean/);
    });
  });

  describe("permissions 'all'", () => {
    it('carries allPermissions into prepare on an engine that declares grantsAllPermissions', async () => {
      const seen: unknown[] = [];
      const { remote } = overLoopback(
        toy({
          grantsAllPermissions: true,
          async prepare(info) {
            seen.push(info.app);
          },
        }),
        {
          validateApp(app) {
            seen.push(app);
          },
        },
      );
      const target = resolveConfig(
        { targets: [{ name: 'phone', platform: 'toy', engine: remote, app: { bundleId: 'dev.shop.app', permissions: 'all' } }] },
        { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv },
      ).targets[0]!;
      await target.engine!.prepare!({ runId: 'run', targetName: target.name, projectRoot: process.cwd(), app: engineAppInfo(target.app), slots: 1, env: {}, headed: false, signal: new AbortController().signal, log: () => {} });
      expect(seen).toEqual([
        { bundleId: 'dev.shop.app', allPermissions: true },
        { bundleId: 'dev.shop.app', allPermissions: true },
      ]);
    });

    it('refuses a server that does not declare the grantsAllPermissions its manifest promised', async () => {
      const local = defineEngine(toy({}));
      const remote = connectEngine({ manifest: { ...describeEngine(local), grantsAllPermissions: true }, transport: loopbackTransport(local) });
      await expect(remote.init!(initInfo())).rejects.toThrow(/grantsAllPermissions is false, declared true/);
    });
  });

  it('serves every in-process target through one protocol client and leaves a connected engine as declared', () => {
    const engine = defineEngine(toy());
    const { remote } = overLoopback(toy());
    const config = resolveConfig(
      { targets: [{ name: 'toy', platform: 'toy', engine }, { name: 'remote', platform: 'toy', engine: remote }] },
      { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv },
    );
    const served = config.targets[0]?.engine;
    expect(served).not.toBe(engine);
    expect(protocolEngine(served!)).toBe(served);
    expect(served?.name).toBe('toy');
    expect([...(served?.capabilities ?? [])]).toEqual([...engine.capabilities]);
    expect(config.targets[1]?.engine).toBe(remote);
    expect(resolveConfig({ targets: [{ name: 'toy', platform: 'toy', engine }] }, { projectRoot: process.cwd(), env: {} as NodeJS.ProcessEnv }).targets[0]?.engine).toBe(served);
  });

  it('rejects a malformed manifest at config load', () => {
    const transport = loopbackTransport(defineEngine(toy()));
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/teleport' as never] }, transport })).toThrow(ConfigurationError);
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/perform'] }, transport })).toThrow(/perform without observe/);
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/observe', 'engine/perform'] }, transport })).toThrow(/perform without actions/);
    expect(() => connectEngine({ manifest: { name: 'x', version: '1', spiVersion: 1, methods: ['engine/observe', 'engine/observe'] }, transport })).toThrow(/twice/);
    // The schema cannot require engine/locate beside it: resolveLocators builds locate on the client.
    const measuring = { name: 'x', version: '1', spiVersion: 1 as const, methods: ['engine/observe', 'engine/viewportIntersection'] as const };
    expect(() => connectEngine({ manifest: measuring, transport })).toThrow(/viewportIntersection without locate/);
    expect(connectEngine({ manifest: measuring, transport, resolveLocators: true }).capabilities.has('viewport-intersection')).toBe(true);
  });
});

describe('engine protocol over a child process', () => {
  const server = fileURLToPath(new URL('../fixtures/protocol-server.ts', import.meta.url));
  const manifest = {
    name: 'toy-server',
    version: '1.0.0',
    spiVersion: 1 as const,
    platform: 'toy',
    methods: ['engine/observe', 'engine/perform', 'lifecycle/init', 'lifecycle/startAttempt', 'lifecycle/endAttempt'] as const,
    actions: ['tap'] as const,
  };

  it('drives an engine in its own process and stops it on dispose', async () => {
    const remote = connectEngine({ manifest: { ...manifest, methods: [...manifest.methods], actions: [...manifest.actions] }, transport: spawnTransport({ command: process.execPath, args: [server] }) });
    const logs: string[] = [];
    await remote.init!(initInfo((line) => logs.push(line)));
    const snapshot = await remote.observe!(operation());
    expect(snapshot.location).toMatch(/^pid:\d+$/);
    expect(snapshot.location).not.toBe(`pid:${String(process.pid)}`);
    await remote.perform!({ id: 'n1', revision: '' }, { kind: 'tap' }, operation());
    expect(logs).toEqual(['init slot 0']);
    await remote.dispose!(cleanup);
    const pid = Number(snapshot.location?.slice('pid:'.length));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stops a server that hangs in doctor and ignores SIGTERM before doctor settles', async () => {
    const remote = connectEngine({
      manifest: { ...manifest, methods: [...manifest.methods, 'lifecycle/doctor'], actions: [...manifest.actions] },
      transport: spawnTransport({ command: process.execPath, args: [server] }),
      initializationOptions: { hangDoctor: true },
    });
    const controller = new AbortController();
    let pid = 0;
    const log = (line: string): void => {
      pid = Number(line.slice('pid:'.length));
      controller.abort();
    };
    await expect(remote.doctor!({ targetName: 'toy', projectRoot: process.cwd(), app: {}, env: process.env, headed: false, signal: controller.signal, log })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }, 15_000);

  it('fails a request with the server stderr when the process dies mid-call', async () => {
    const remote = connectEngine({
      manifest: { ...manifest, methods: [...manifest.methods], actions: [...manifest.actions] },
      transport: spawnTransport({ command: process.execPath, args: [server] }),
      initializationOptions: { crashOnObserve: true },
    });
    await remote.init!(initInfo());
    await expect(remote.observe!(operation())).rejects.toThrow(/closed the connection[\s\S]*crashing on purpose/);
    await remote.dispose!(cleanup);
  });

  /** A client of the toy server in `crashMode`, initialized. */
  async function crashing(crashMode: CrashMode) {
    const remote = connectEngine({
      manifest: { ...manifest, methods: [...manifest.methods], actions: [...manifest.actions] },
      transport: spawnTransport({ command: process.execPath, args: [server] }),
      initializationOptions: { crashOnObserve: true, crashMode },
    });
    await remote.init!(initInfo());
    return remote;
  }

  it('waits for the exit code and stderr of a server whose stdout closed before it exited', async () => {
    const remote = await crashing('stdout-first');
    const start = Date.now();
    await expect(remote.observe!(operation())).rejects.toThrow(/closed the connection[\s\S]*exited with code 7[\s\S]*crashing on purpose/);
    // Well under the 2 s a transport waits at most: the exit ends the wait.
    expect(Date.now() - start).toBeLessThan(1_500);
    await remote.dispose!(cleanup);
  });

  it('waits for stderr a child of the server writes after the server exited', async () => {
    const remote = await crashing('late-child');
    await expect(remote.observe!(operation())).rejects.toThrow(/exited with code 7[\s\S]*toy server child: late line/);
    await remote.dispose!(cleanup);
  });

  it('fails a request of a server that closed its stdout and keeps running', async () => {
    const remote = await crashing('stays-up');
    const start = Date.now();
    await expect(remote.observe!(operation())).rejects.toThrow(/closed the connection[\s\S]*stdout closed, staying/);
    // The 2 s cap, not the test timeout, ends the wait.
    expect(Date.now() - start).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - start).toBeLessThan(3_000);
    await remote.dispose!(cleanup);
  }, 10_000);

  it('names the signal that stopped a server mid-request, and its stderr', async () => {
    const remote = await crashing('signal');
    await expect(remote.observe!(operation())).rejects.toThrow(/killed by SIGKILL[\s\S]*crashing on purpose/);
    await remote.dispose!(cleanup);
  });
});

describe('engine protocol against a server written from the messages alone', () => {
  /** A server that speaks raw JSON-RPC, as one in another language would: no `serveEngine`, no engine handle. */
  function handWritten(
    methods: readonly string[] = ['engine/observe', 'artifacts/screenshot', 'lifecycle/startAttempt'],
    overrides: Readonly<Record<string, (params: unknown) => Promise<unknown>>> = {},
  ): { transport: EngineTransport; received: string[] } {
    const received: string[] = [];
    const transport: EngineTransport = {
      label: 'hand-written',
      async open() {
        const toServer = new PassThrough();
        const toClient = new PassThrough();
        const manifest = { name: 'hand', version: '1', spiVersion: 1, methods };
        const record = (method: string) => async (params: unknown) => {
          received.push(method);
          return params;
        };
        const server: Connection = new Connection(
          { input: toServer, output: toClient },
          {
            requests: {
              initialize: async () => ({ protocolVersion: 1, manifest }),
              shutdown: record('shutdown'),
              'lifecycle/startAttempt': async (params) => {
                received.push('lifecycle/startAttempt');
                server.notify('attempt/environment', { attemptId: (params as { attemptId: string }).attemptId, facts: { written: 'by hand' } });
                return null;
              },
              'engine/observe': async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } }),
              'artifacts/screenshot': async () => ({ data: Buffer.from('png bytes').toString('base64'), mediaType: 'image/png' }),
              ...overrides,
            },
            notifications: { exit: () => server.close('exit') },
          },
        );
        return {
          input: toClient,
          output: toServer,
          close: async () => {
            received.push('transport closed');
            toServer.end();
          },
        };
      },
    };
    return { transport, received };
  }

  it('closes the transport when a server ignores its dispose budget', async () => {
    const methods = ['engine/observe', 'lifecycle/dispose'] as const;
    const { transport, received } = handWritten([...methods], { 'lifecycle/dispose': () => new Promise(() => {}) });
    const remote = connectEngine({ manifest: { name: 'hand', version: '1', spiVersion: 1, methods: [...methods] }, transport });
    await remote.init!(initInfo());
    await expect(remote.dispose!({ signal: new AbortController().signal, timeoutMs: 50 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(received).toContain('transport closed');
  });

  it('refuses a server that speaks another protocol version', async () => {
    const { transport } = handWritten(['engine/observe'], {
      initialize: async () => ({ protocolVersion: 999, manifest: { name: 'hand', version: '1', spiVersion: 1, methods: ['engine/observe'] } }),
    });
    const remote = connectEngine({ manifest: { name: 'hand', version: '1', spiVersion: 1, methods: ['engine/observe'] }, transport });
    await expect(remote.init!(initInfo())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringContaining('protocol 999') });
  });

  it('rejects a request answered with a malformed error instead of throwing out of the stream', async () => {
    const input = new PassThrough();
    const connection = new Connection({ input, output: new PassThrough() });
    const pending = connection.request('engine/observe', {});
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, error: null });
    input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await expect(pending).rejects.toMatchObject({ code: -32603, message: expect.stringContaining('malformed error') });
  });

  it('reads a message that arrives a byte at a time, and two that arrive in one chunk', async () => {
    const input = new PassThrough();
    const seen: unknown[] = [];
    const connection = new Connection({ input, output: new PassThrough() }, { notifications: { note: (params) => void seen.push(params) } });
    const frame = (params: unknown): Buffer => {
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'note', params });
      return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    for (const byte of frame('één')) input.write(Buffer.from([byte]));
    input.write(Buffer.concat([frame(2), frame(3)]));
    input.write(frame(4));
    await vi.waitFor(() => expect(seen).toEqual(['één', 2, 3, 4]));
    expect(connection.closed).toBeUndefined();
  });

  it('reports a malformed notification instead of crashing', async () => {
    const toClient = new PassThrough();
    const logs: string[] = [];
    const transport: EngineTransport = {
      label: 'malformed',
      async open() {
        const toServer = new PassThrough();
        const server: Connection = new Connection(
          { input: toServer, output: toClient },
          {
            requests: {
              initialize: async () => {
                server.notify('engine/log');
                server.notify('engine/log', { line: 'still here' });
                return { protocolVersion: 1, manifest: { name: 'bad', version: '1', spiVersion: 1, methods: ['engine/observe'] } };
              },
              'engine/observe': async () => ({ root: { ref: { id: 'root', revision: '' } }, viewport: { width: 1, height: 1 } }),
            },
          },
        );
        return { input: toClient, output: toServer, close: async () => void toServer.end() };
      },
    };
    const remote = connectEngine({ manifest: { name: 'bad', version: '1', spiVersion: 1, methods: ['engine/observe'] }, transport });
    await remote.init!(initInfo((line) => logs.push(line)));
    await remote.observe!(operation());
    expect(logs).toEqual([expect.stringMatching(/^engine server malformed sent a malformed "engine\/log" notification: /), 'still here']);
    await remote.dispose!(cleanup);
  });

  it('writes a screenshot a server returned as bytes into the attempt directory', async () => {
    const { transport, received } = handWritten();
    const remote = connectEngine({ manifest: { name: 'hand', version: '1', spiVersion: 1, methods: ['engine/observe', 'artifacts/screenshot', 'lifecycle/startAttempt'] }, transport });
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protocol-'));
    const facts: Record<string, string>[] = [];
    await remote.init!(initInfo());
    await remote.startAttempt!({
      attemptId: 'attempt-1',
      artifactsDir,
      signal: new AbortController().signal,
      resolveSecret: async () => '',
      appLog: () => {},
      navigation: () => {},
      environment: (entry) => facts.push({ ...entry }),
    });
    const relative = await remote.artifacts!.screenshot('after login', operation());
    expect(relative).toBe(path.join('screenshots', '001-after_login.png'));
    expect(readFileSync(path.join(artifactsDir, relative), 'utf8')).toBe('png bytes');
    expect(facts).toEqual([{ written: 'by hand' }]);
    await remote.dispose!(cleanup);
    expect(received).toEqual(['lifecycle/startAttempt', 'shutdown', 'transport closed']);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('writes a screenshot\'s bytes into the attempt directory for a server that does not answer startAttempt', async () => {
    const methods = ['engine/observe', 'artifacts/screenshot'] as const;
    const { transport } = handWritten(methods);
    const remote = connectEngine({ manifest: { name: 'hand', version: '1', spiVersion: 1, methods: [...methods] }, transport });
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-protocol-'));
    await remote.init!(initInfo());
    await remote.startAttempt!({ attemptId: 'attempt-1', artifactsDir, signal: new AbortController().signal, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} });
    expect(await remote.artifacts!.screenshot(undefined, operation())).toBe(path.join('screenshots', '001-screenshot.png'));
    await remote.dispose!(cleanup);
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('refuses a screenshot path outside the attempt directory', async () => {
    const local = defineEngine(toy({ artifacts: { screenshot: async () => '../../elsewhere.png' }, startAttempt: async () => {} }));
    const remote = connectEngine({ manifest: describeEngine(local), transport: loopbackTransport(local) });
    await remote.init!(initInfo());
    await remote.startAttempt!({ attemptId: 'attempt-1', artifactsDir: tmpdir(), signal: new AbortController().signal, resolveSecret: async () => '', appLog: () => {}, navigation: () => {}, environment: () => {} });
    await expect(remote.artifacts!.screenshot(undefined, operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE' });
    await remote.dispose!(cleanup);
  });
});
