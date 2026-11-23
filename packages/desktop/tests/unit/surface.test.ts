import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { OperationContext, SemanticNode } from '@e2e-dev/core/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { pinnedExecutable } from '../../src/binary.ts';
import { resolveOptions } from '../../src/options.ts';
import { DesktopSurface } from '../../src/surface.ts';
import { cleanupFakes, failure, fakeScenario, snapshotAnswer, type Scenario } from '../helpers/fake.ts';

const signal = new AbortController().signal;

const children: ChildProcess[] = [];
const fakes: { spawned: () => number[] }[] = [];
const surfaces: DesktopSurface[] = [];

afterEach(async () => {
  // Disposing removes each surface's private agent-desktop state directory.
  for (const surface of surfaces.splice(0)) await surface.dispose({ signal, timeoutMs: 2_000 }).catch(() => undefined);
  for (const child of children.splice(0)) child.kill('SIGKILL');
  // Before cleanupFakes, which removes the files that list the processes the fakes started.
  for (const fake of fakes.splice(0)) {
    for (const pid of fake.spawned()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already quit by the test.
      }
    }
  }
  cleanupFakes();
  for (const directory of artifactDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** The artifact directories attempts were given, removed after each test. */
const artifactDirs: string[] = [];

function artifacts(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-artifacts-'));
  artifactDirs.push(directory);
  return directory;
}

/** A surface disposed after the test, so its state directory is removed. */
function tracked(surface: DesktopSurface): DesktopSurface {
  surfaces.push(surface);
  return surface;
}

/** In a scripted answer, the pid of the process the fake's `launch` started for the app. */
const SPAWNED = '$spawned' as unknown as number;

/** Whether a process is gone within `ms`. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function operation(origin: 'test' | 'agent' = 'test'): OperationContext {
  return { signal, timeoutMs: 10_000, runId: 'run', attemptId: 'attempt', origin };
}

/** A real process standing in for a copy of the app the engine did not launch: the developer's own. */
function otherCopy(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  children.push(child);
  return child.pid!;
}

/** A real process with no environment at all, which `ps -E` shows as it shows a restricted app's: unreadable. */
function unreadableCopy(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: {} });
  children.push(child);
  return child.pid!;
}

/** A process's environment as text, read the way the engine reads it. */
async function environmentOf(pid: number): Promise<string> {
  if (process.platform === 'linux') return readFileSync(`/proc/${pid}/environ`, 'utf8').replaceAll('\0', ' ');
  return execFileSync('ps', ['-E', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
}

/** A snapshot fixture's answer with its refs and window renamed, as a later snapshot of the same window reports it. */
function renamed(name: string, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(snapshotAnswer(name)).replaceAll(from, to)) as unknown;
}

/**
 * A surface initialized for an `appPath` target: a bundle in a scratch
 * directory, and a stand-in for macOS's `open` first on PATH. The stand-in
 * writes its arguments to `recorded`, then runs `body` (sh), where `SPAWNED`
 * names the file the fake lists started processes from.
 */
async function appPathSurface(body: string, scenario: Scenario = {}, runHeaded = false) {
  const directory = artifacts();
  const bundle = path.join(directory, 'Built.app');
  mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
  const fake = fakeScenario({
    status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }],
    'list-apps': [{ ok: true, data: { apps: [] } }, { spawnedApps: { name: 'Built', bundle_id: 'dev.e2e.built' } }],
    'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid: SPAWNED, process_instance: 'spawned-$spawned', is_focused: true }] }],
    snapshot: [snapshotAnswer('macos/appkit-form')],
    ...scenario,
  });
  fakes.push(fake);
  const bin = path.join(directory, 'bin');
  mkdirSync(bin);
  const recorded = path.join(directory, 'open-args');
  const spawnedFile = path.join(path.dirname(fake.binary), 'calls.jsonl.spawned');
  writeFileSync(path.join(bin, 'open'), `#!/bin/sh\nSPAWNED=${JSON.stringify(spawnedFile)}\nprintf '%s\\n' "$@" > ${JSON.stringify(recorded)}\n${body}`, { mode: 0o755 });
  const surface = tracked(new DesktopSurface(resolveOptions({ binary: fake.binary, settle: false }), 'macos'));
  await surface.init({ runId: 'r', targetName: 'mac', projectRoot: directory, app: { appPath: 'Built.app' }, env: { ...fake.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, headed: runHeaded, workerSlot: 0, signal, log: () => undefined });
  return { surface, fake, bundle, recorded };
}

interface Launch {
  readonly snapshot?: string;
  /** The run's own `--headed`, as `init` receives it. */
  readonly runHeaded?: boolean;
  readonly openTimeoutMs?: number;
  readonly observe?: boolean;
  readonly options?: Parameters<typeof resolveOptions>[0];
}

/**
 * A surface on the scripted agent-desktop, initialized but with nothing
 * launched. The fake's `launch` starts a real process with the launch's
 * environment (its token) and reports it, as agent-desktop does; `app.pid`
 * is that process once launched.
 */
async function initialized(scenario: Scenario | ((pid: number) => Scenario), { snapshot = 'macos/appkit-form', options = {}, runHeaded = false }: Launch = {}) {
  const fake = fakeScenario({
    status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }],
    launch: [{ spawn: true, ok: true, data: { app: 'SpikeForm', pid: SPAWNED, process_instance: 'instance-1' } }],
    'list-windows': [{ ok: true, data: [{ id: 'w-mine', title: 'Spike Form', pid: SPAWNED, process_instance: 'instance-1', is_focused: true }, { id: 'w-theirs', title: 'Spike Form', pid: 1, is_focused: false }] }],
    'list-apps': [{ ok: true, data: { apps: [{ pid: SPAWNED, process_instance: 'instance-1' }] } }],
    snapshot: [snapshotAnswer(snapshot)],
    ...(typeof scenario === 'function' ? scenario(SPAWNED) : scenario),
  });
  fakes.push(fake);
  const app = {
    get pid(): number {
      const pid = fake.spawned().at(-1);
      if (pid === undefined) throw new Error('nothing was launched');
      return pid;
    },
  };
  const surface = new DesktopSurface(resolveOptions({ binary: fake.binary, settle: false, ...options }), 'macos');
  surfaces.push(surface);
  await surface.init({
    runId: 'run',
    targetName: 'macos',
    projectRoot: process.cwd(),
    app: { bundleId: 'dev.e2e.spike.form' },
    // A secret in the run's environment, which neither agent-desktop nor the app it launches may see.
    env: { ...fake.env, E2E_PROBE_SECRET: 'hunter2' },
    headed: runHeaded,
    workerSlot: 0,
    signal,
    log: () => undefined,
  });
  return { surface, fake, app };
}

/** A surface on the scripted agent-desktop, with the form launched (a real child process as the app) and observed once. */
async function launched(scenario: Scenario | ((pid: number) => Scenario), launch: Launch = {}) {
  const { openTimeoutMs = 10_000, observe = true } = launch;
  const { surface, fake, app } = await initialized(scenario, launch);
  await surface.restart({ ...operation(), timeoutMs: openTimeoutMs });
  const nodes = observe ? await surface.observe(operation(), undefined).then((observed) => [observed.root, ...(observed.root.children ?? [])]) : [];
  const byTestId = (testId: string) => {
    const node = nodes.find((candidate) => candidate.testId === testId);
    if (node === undefined) throw new Error(`no node ${testId}`);
    return node.ref;
  };
  return { surface, fake, byTestId, app };
}

/** The keys of the calls that act or read the app, without the bookkeeping around them. */
function actions(calls: readonly { key: string }[]): string[] {
  return calls.map((call) => call.key).filter((key) => !['status', 'launch', 'list-windows', 'list-apps'].includes(key));
}

const startAttempt = (surface: DesktopSurface) =>
  surface.startAttempt({
    attemptId: 'a',
    artifactsDir: artifacts(),
    resolveSecret: async () => '',
    signal,
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });

describe('DesktopSurface', () => {
  it('launches the app by id and reads only the window of the process it launched', async () => {
    const { fake } = await launched({});
    const calls = fake.calls();
    const launch = calls.find((call) => call.key === 'launch')?.args;
    expect(launch).toEqual(expect.arrayContaining(['launch', 'dev.e2e.spike.form', '--no-attach', '--arg=-ApplePersistenceIgnoreState', '--arg=YES']));
    // In the background: the app never takes the keyboard from whoever is at the Mac.
    expect(launch).not.toContain('--activate');
    expect(calls.find((call) => call.key === 'list-windows')?.args.slice(0, 3)).toEqual(['list-windows', '--app', 'SpikeForm']);
    const snapshot = calls.find((call) => call.key === 'snapshot');
    expect(snapshot?.args).toEqual(expect.arrayContaining(['--window-id', 'w-mine', '--include-bounds']));
    expect(calls.some((call) => call.args.includes('w-theirs'))).toBe(false);
    expect(new Set(calls.map((call) => call.home)).size).toBe(1);
  });

  it('reads and drives nothing before the app is opened, or once it quit', async () => {
    const { surface, fake } = await launched({}, { observe: false });
    await surface.closeApp(signal, 5_000);
    const before = fake.calls().length;
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children).toBeUndefined();
    expect(await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, operation())).toEqual([]);
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls().slice(before).map((call) => call.key)).toEqual([]);
  });

  it('fills through stdin, so a secret never reaches the process arguments', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('password'), { kind: 'fill', value: 'hunter2', sensitive: true }, operation());
    const fill = fake.calls().find((call) => call.key === 'set-value');
    expect(fill?.args).toEqual(['set-value', '@s1y1hxmo5pexrl:e2', '--timeout-ms', expect.any(String), '--stdin']);
    // agent-desktop's own wait is what is left of the operation's budget, less the margin it answers within.
    expect(Number(fill?.args[3])).toBeGreaterThan(9_000);
    expect(Number(fill?.args[3])).toBeLessThanOrEqual(9_600);
    expect(fill?.stdin).toBe('hunter2');
    expect(fake.calls().some((call) => call.args.join(' ').includes('hunter2'))).toBe(false);
  });

  it('leaves whether a box needs checking to agent-desktop, which reads its live state', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('remember'), { kind: 'check' }, operation());
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(actions(fake.calls()).slice(-2)).toEqual(['check', 'uncheck']);
  });

  it('never sets the value of a list select refused, so no label lands in it as free text', async () => {
    const editable = { ok: true, data: { snapshot_id: 's5', window: { id: 'w-mine' }, tree: { role: 'window', name: 'Form', children: [{ role: 'combobox', name: 'Plan', ref_id: '@s5:e1', available_actions: ['Click', 'SetFocus'] }] } } };
    const refusals = { ACTION_NOT_SUPPORTED: 'UNSUPPORTED_CAPABILITY', POLICY_DENIED: 'UNSUPPORTED_CAPABILITY', TIMEOUT: 'NOT_ACTIONABLE', AMBIGUOUS_TARGET: 'NOT_ACTIONABLE' } as const;
    for (const [refusal, code] of Object.entries(refusals)) {
      const { surface, fake } = await launched({ snapshot: [editable], select: [failure(refusal, 'not_delivered')] }, { observe: false });
      const observed = await surface.observe(operation(), undefined);
      await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code });
      expect(fake.calls().find((call) => call.key === 'select')?.args.slice(-2)).toEqual(['--', 'Team']);
      expect(fake.calls().some((call) => call.key === 'set-value')).toBe(false);
    }
  });

  it('passes a label that starts with a dash after --, so it is never read as a flag', async () => {
    const { surface, fake, byTestId } = await launched({});
    await surface.perform(byTestId('plan'), { kind: 'selectOption', value: '- None -' }, operation());
    expect(fake.calls().find((call) => call.key === 'select')?.args.slice(-2)).toEqual(['--', '- None -']);
  });

  it('sets no value after a select that may have landed', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('ACTION_FAILED', 'delivered_unverified')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    expect(fake.calls().some((call) => call.key === 'set-value')).toBe(false);
  });

  it('reports a stale ref in a select as stale, so the list is located again', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('STALE_REF', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(fake.calls().some((call) => call.key === 'set-value')).toBe(false);
  });

  it('keeps a control id across observations of a window and acts on its newest ref', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 's1y1hxmo5pexrl', 'snewer')] });
    const signIn = byTestId('sign-in');
    const again = await surface.observe(operation(), undefined);
    expect(again.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
    await surface.perform(signIn, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['click', '@snewer:e5']);
    await expect(surface.perform({ id: 'n9999', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('gives a control in another window an id of its own', async () => {
    const { surface, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-other')] });
    const signIn = byTestId('sign-in');
    const other = await surface.observe(operation(), undefined);
    expect(other.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).not.toBe(signIn.id);
  });

  it('retires an id once its control has a look-alike, so a surviving twin never inherits it', async () => {
    const button = (ref: string) => ({ role: 'button', name: 'Delete', ref_id: ref });
    const screen = (id: string, buttons: readonly unknown[]) => ({ ok: true, data: { snapshot_id: id, window: { id: 'w-1' }, tree: { role: 'window', name: 'List', children: buttons } } });
    const { surface } = await launched(
      { snapshot: [screen('s1', [button('@s1:e1')]), screen('s1', [button('@s1:e1')]), screen('s2', [button('@s2:e1'), button('@s2:e2')]), screen('s3', [button('@s3:e2')])] },
      { observe: false },
    );
    const first = await surface.observe(operation(), undefined);
    const original = first.root.children?.[0]?.ref.id;
    await surface.observe(operation(), undefined);
    const last = await surface.observe(operation(), undefined);
    expect(last.root.children?.[0]?.ref.id).not.toBe(original);
  });

  it('refuses to act on text agent-desktop gave no ref', async () => {
    const { surface } = await launched({});
    await expect(surface.perform({ id: 'root', revision: '' }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('presses keys as agent-desktop combos into the window of the launched process', async () => {
    const { surface, fake } = await launched({});
    await surface.pressKey('ControlOrMeta+a', operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'cmd+a', '--window-id', 'w-mine']);
  });

  it('sends no key to whatever has focus when the control it was meant for refuses focus', async () => {
    const { surface, fake, byTestId } = await launched({ focus: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')] });
    await expect(surface.perform(byTestId('sign-in'), { kind: 'press', key: 'Enter' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('double-clicks with the real pointer, which agent-desktop requires', async () => {
    const { surface, fake, byTestId } = await launched({}, { options: { headed: true } });
    await surface.perform(byTestId('sign-in'), { kind: 'doubleTap' }, operation());
    expect(fake.calls().find((call) => call.key === 'double-click')?.args).toContain('--headed');
  });

  it('scrolls the window on a root swipe right after a restart', async () => {
    const scrollable = { ok: true, data: { snapshot_id: 's9', window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', ref_id: '@s9:e1' }] } } };
    const { surface, fake } = await launched({ snapshot: [scrollable] }, { observe: false });
    await surface.restart(operation());
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['scroll', '@s9:e1']);
  });

  it('reads again when the window closed while it was read, so a locator keeps polling', async () => {
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')] });
    const username = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } } as const;
    await expect(surface.locate(username, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reads again when the window list does not find the app while its process still runs, never an empty screen', async () => {
    const { surface } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, failure('APP_NOT_FOUND', 'not_delivered')] }), { observe: false });
    const username = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } } as const;
    await expect(surface.locate(username, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it("gives every app and window inventory the operation's budget, not agent-desktop's own 5 s default", async () => {
    const { surface, fake } = await launched({}, { observe: false });
    await surface.observe({ ...operation(), timeoutMs: 2_000 }, undefined);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    const inventories = fake.calls().filter((call) => call.key === 'list-windows' || call.key === 'list-apps');
    expect(inventories.length).toBeGreaterThan(0);
    for (const call of inventories) expect(call.args).toContain('--timeout-ms');
    const observed = fake.calls().findLast((call) => call.key === 'list-windows')!;
    expect(Number(observed.args[observed.args.indexOf('--timeout-ms') + 1])).toBeLessThanOrEqual(2_000);
  });

  it("cuts an observation's names at 256 and text at 512, and still locates by the whole text", async () => {
    const long = 'L'.repeat(1_200);
    const labelled = JSON.parse(JSON.stringify(snapshotAnswer('macos/appkit-form')).replace('"name":"Username"', `"name":"${long}"`)) as unknown;
    const { surface } = await launched({ snapshot: [labelled] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    const field = observed.root.children?.find((node) => node.testId === 'username');
    expect(field?.name).toBe(long.slice(0, 256));
    const all = (node: SemanticNode): SemanticNode[] => [node, ...(node.children ?? []).flatMap(all)];
    for (const node of all(observed.root)) {
      expect(node.name?.length ?? 0).toBeLessThanOrEqual(256);
      expect(node.text?.length ?? 0).toBeLessThanOrEqual(512);
    }
    const byName = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: long, exact: true } } } as const;
    expect(await surface.locate(byName, operation())).toHaveLength(1);
  });

  it('reads again, never reports a quit, while the app list leaves out the app that still runs', async () => {
    // The window list finds no window, and the app list no longer shows the process, which still runs as the launch's.
    const { surface } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [] }], 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [] } }] }), { observe: false });
    const username = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } } as const;
    await expect(surface.locate(username, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('reads an app with no window as an empty screen', async () => {
    const { surface } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [] }] }), { observe: false });
    const matches = await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } }, operation());
    expect(matches).toEqual([]);
  });

  it('fails the open when the window never becomes readable, as on a locked screen', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    await expect(launched({ snapshot: [hidden] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/cannot be read through accessibility/);
  }, 30_000);

  it('reports a launch whose window reads ran out of time as unreadable, not as an app that opened no window', async () => {
    // A locked screen: listing the windows times out, so nothing shows whether the app has one.
    await expect(launched({ 'list-windows': [failure('TIMEOUT', 'not_delivered')] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/cannot be read through accessibility \(a read ran out of time\)/);
  });

  it('says a background app that opens no window needs headed, however the wait ends against a slow window list', async () => {
    // Each read takes 700 ms: without a floor, the last read of the wait gets a sliver of it, times out, and the open blames a locked screen.
    await expect(launched({ 'list-windows': [{ ok: true, data: [], sleepMs: 700 }] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/opened no window.*desktop\(\{ headed: true \}\)/);
  }, 30_000);

  it('says a foreground launch listed no window, rather than that its window cannot be read', async () => {
    await expect(launched({ 'list-windows': [{ ok: true, data: [] }] }, { runHeaded: true, openTimeoutMs: 15_000 })).rejects.toThrow(/listed no window within 10 s/);
  }, 30_000);

  it('reads until the end of the launch wait, so a window that shows up late still opens', async () => {
    // The first window list takes 9.1 s of the 10 s wait and lists none; the next one finds the window.
    await launched((pid) => ({ 'list-windows': [{ ok: true, data: [], sleepMs: 9_100 }, { ok: true, data: [{ id: 'w-mine', title: 'Spike Form', pid, process_instance: 'instance-1', is_focused: true }] }] }), { openTimeoutMs: 15_000, observe: false });
  }, 30_000);

  it('says the screen is locked when macOS reports it so, rather than that the app opened no window', async () => {
    const locked = artifacts();
    writeFileSync(path.join(locked, 'ioreg'), "#!/bin/sh\nprintf '<key>CGSSessionScreenIsLocked</key>\\n<true/>\\n'\n", { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${locked}${path.delimiter}${originalPath}`;
    try {
      // What a locked screen gives: a window list that finishes and lists none.
      await expect(launched({ 'list-windows': [{ ok: true, data: [] }] }, { openTimeoutMs: 15_000 })).rejects.toThrow(/screen is locked/);
    } finally {
      process.env.PATH = originalPath;
    }
  }, 30_000);

  it('reports an open that ran out of its own budget as a timeout, not a locked screen', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    await expect(launched({ snapshot: [hidden] }, { openTimeoutMs: 1_500 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
  });

  it('reports a read that fails for another reason as it is, not as a locked screen', async () => {
    await expect(launched({ snapshot: [failure('PERM_DENIED', 'not_delivered')] }, { openTimeoutMs: 1_500 })).rejects.toThrow(/Accessibility/);
    await expect(launched({ snapshot: [failure('PERM_DENIED', 'not_delivered')] }, { openTimeoutMs: 1_500 })).rejects.not.toThrow(/screen may be locked/);
  });

  it('sends nothing once the operation budget is spent', async () => {
    const { surface, fake, byTestId } = await launched({});
    const before = fake.calls().length;
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, { ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(fake.calls()).toHaveLength(before);
  });

  it('withholds a screenshot when the snapshot did not read the whole window', async () => {
    const partial = snapshotAnswer('macos/sign-in-form') as { ok: true; data: Record<string, unknown> };
    const { surface } = await launched({ snapshot: [{ ...partial, data: { ...partial.data, complete: false } }] }, { snapshot: 'macos/sign-in-form' });
    await startAttempt(surface);
    await expect(surface.screenshot('partial', operation())).rejects.toThrow(/did not read the whole window/);
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    // Withheld pixels still report the regions masked, none, so the harness reads unproven masking, not a missing screenshot.
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('refuses a screenshot as a policy when a password field has no bounds to mask', async () => {
    // The AppKit form's password field was captured with no bounds.
    const { surface } = await launched({});
    await startAttempt(surface);
    await expect(surface.screenshot('unmaskable', operation())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const observed = await surface.observe(operation(), { pixels: true });
    expect(observed.pixels).toBeUndefined();
    expect(observed.maskedRegionCount).toBe(0);
  });

  it('withholds a screenshot when a secure field moved while it was captured, and keeps one that did not', async () => {
    const form = renamed('macos/sign-in-form', 'w-8321', 'w-mine');
    const moved = JSON.parse(JSON.stringify(form).replace('"y":675', '"y":700')) as unknown;
    // The window and its capture as agent-desktop reports them: the capture is the window's size at scale 1, all black.
    const { width, height } = (form as { data: { tree: { bounds: { width: number; height: number } } } }).data.tree.bounds;
    const capture = (pid: number) => ({ screenshot: [{ ok: true, writePng: { width, height }, data: { scale_factor: 1 } }], 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }] });
    const steady = await launched((pid) => ({ ...capture(pid), snapshot: [form] }), { snapshot: 'macos/sign-in-form' });
    await startAttempt(steady.surface);
    await expect(steady.surface.screenshot('steady', operation())).resolves.toMatch(/steady\.png$/);
    const { surface } = await launched((pid) => ({ ...capture(pid), snapshot: [form, form, form, moved] }), { snapshot: 'macos/sign-in-form' });
    await startAttempt(surface);
    await expect(surface.screenshot('moved', operation())).rejects.toThrow(/window changed while it was captured/);
  });

  it('kills nothing when the id it launched now names another process', async () => {
    // agent-desktop lists the id with another process instance: the process the engine launched is gone, and another took its id.
    const { surface, app } = await launched((pid) => ({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [{ pid, process_instance: 'instance-2' }] } }] }));
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(app.pid, 300)).toBe(false);
  });

  it('keeps the process as its own when a quit fails, so dispose quits it', async () => {
    const { surface, app, fake } = await launched((pid) => ({ 'list-apps': [{ ok: true, data: { apps: [] } }, failure('INTERNAL', 'not_delivered'), { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }] }), { observe: false });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/find SpikeForm/);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(fake.calls().filter((call) => call.key === 'list-apps')).toHaveLength(3);
    expect(await gone(app.pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('takes as its own the process a failed launch started, by its launch token, and quits it', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: true, ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      'list-apps': [{ spawnedApps: { name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form' } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    const [started] = fake.spawned();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(started).toBeDefined();
    expect(() => process.kill(started!, 0)).toThrow();
  });

  it('says which app is missing when the bundle id names none', async () => {
    const { surface } = await initialized({ launch: [failure('APP_NOT_FOUND', 'not_delivered')] });
    await expect(surface.restart(operation())).rejects.toThrow(/no installed app has the name or bundle id "dev.e2e.spike.form"/);
  });

  it('reads a window of its own process only, not one a later process with the same id owns', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-replacement', pid, process_instance: 'instance-2', is_focused: true }] }] }));
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls().some((call) => call.args.includes('w-replacement'))).toBe(false);
  });

  it('keeps the process when the app list is incomplete, so dispose looks again', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [], complete: false } }, { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }] }), { observe: false });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/listed the apps only in part/);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(fake.calls().filter((call) => call.key === 'list-apps')).toHaveLength(3);
  });

  it('keeps the launch record, and the process it names, when dispose could not quit the app, and drops the field text', async () => {
    const { surface, fake, app } = await launched({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [], complete: false } }] }, { observe: false });
    const home = fake.calls()[0]!.home!;
    // What agent-desktop keeps of the app's fields in its state directory.
    mkdirSync(path.join(home, 'refs'));
    writeFileSync(path.join(home, 'refs', 'fields.json'), '{"value":"ada"}');
    try {
      await expect(surface.dispose({ signal, timeoutMs: 5_000 })).rejects.toThrow(/listed the apps only in part/);
      expect(readdirSync(home).toSorted()).toEqual(['app.json', 'owner']);
      const record = JSON.parse(readFileSync(path.join(home, 'app.json'), 'utf8')) as { token: string; pid: number; started: string };
      expect(await environmentOf(app.pid)).toContain(`E2E_DESKTOP_LAUNCH=${record.token}`);
      // The process, by its id and when it started, so a later run can quit it without reading its environment.
      expect(record).toMatchObject({ pid: app.pid, started: execFileSync('ps', ['-o', 'lstart=', '-p', String(app.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim() });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('quits the app a complete app list leaves out while its process still runs, as macOS does for a prohibited activation policy', async () => {
    const { surface, fake, app } = await launched({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [] } }] }, { observe: false });
    const home = fake.calls()[0]!.home!;
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(app.pid)).toBe(true);
    expect(existsSync(path.join(home, 'app.json'))).toBe(false);
  });

  it("starts a reused handle's next host clean, though the last one left a launch it could not settle", async () => {
    const { surface, fake } = await initialized({
      launch: [failure('TIMEOUT', 'unknown')],
      'list-apps': [{ ok: true, data: { apps: [], complete: false } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/could not tell/);
    await expect(surface.dispose({ signal, timeoutMs: 5_000 })).rejects.toThrow(/could not tell/);
    // The next host's app is healthy: it launches and lists as it should.
    writeFileSync(path.join(path.dirname(fake.binary), 'scenario.json'), JSON.stringify({
      status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }],
      launch: [{ spawn: true, ok: true, data: { app: 'SpikeForm', pid: '$spawned', process_instance: 'instance-1' } }],
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid: '$spawned', process_instance: 'instance-1', is_focused: true }] }],
      'list-apps': [{ ok: true, data: { apps: [{ pid: '$spawned', process_instance: 'instance-1' }] } }],
      snapshot: [snapshotAnswer('macos/appkit-form')],
    }));
    await surface.init({ runId: 'run-2', targetName: 'macos', projectRoot: process.cwd(), app: { bundleId: 'dev.e2e.spike.second' }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.restart(operation());
    expect(fake.calls().findLast((call) => call.key === 'launch')?.args[1]).toBe('dev.e2e.spike.second');
  }, 30_000);

  it.skipIf(process.platform === 'win32')('quits the process a failed launch started, claimed by its token, though the app list then leaves it out', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: true, ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      // Before the launch: none. The quit claims the process by its token, and the list after leaves it out (a prohibited activation policy).
      'list-apps': [{ ok: true, data: { apps: [] } }, { spawnedApps: { name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form' } }, { ok: true, data: { apps: [] } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.spawned().at(-1)!)).toBe(true);
  });

  it('quits the app a failed dispose left running at the next init in the same process', async () => {
    const { surface, fake, app } = await launched({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [], complete: false } }] }, { observe: false });
    const home = fake.calls()[0]!.home!;
    try {
      await expect(surface.dispose({ signal, timeoutMs: 5_000 })).rejects.toThrow(/listed the apps only in part/);
      expect(await gone(app.pid, 300)).toBe(false);
      // A second host in this process, as a program that opens one after another does.
      await initialized({});
      expect(await gone(app.pid)).toBe(true);
      expect(existsSync(home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('replaces the focused field as a keyboard does, select all and delete, and never by an accessibility clear', async () => {
    // The form's Username field has keyboard focus.
    const { surface, fake } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')] }, { options: { headed: true } });
    await surface.typeText('ada', { replace: true }, operation());
    const sent = actions(fake.calls()).filter((key) => key !== 'snapshot');
    expect(sent).toEqual(['press', 'press', 'type']);
    const presses = fake.calls().filter((call) => call.key === 'press').map((call) => call.args[1]);
    expect(presses).toEqual(['cmd+a', 'backspace']);
  });

  it('sends nothing when the control with keyboard focus takes no text, so no select-all or delete reaches a list or button', async () => {
    const focusedButton = JSON.parse(
      JSON.stringify(snapshotAnswer('macos/appkit-form'))
        .replace('"states":["focused"]', '"states":[]')
        .replace('"native_id":{"kind":"ax_identifier","value":"sign-in"}', '"native_id":{"kind":"ax_identifier","value":"sign-in"},"states":["focused"]'),
    ) as unknown;
    const { surface, fake } = await launched({ snapshot: [focusedButton] }, { options: { headed: true } });
    for (const replace of [true, false]) {
      await expect(surface.typeText('ada', { replace }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/takes no text/) });
    }
    expect(actions(fake.calls()).filter((key) => key !== 'snapshot')).toEqual([]);
  });

  it('refuses text agent-desktop cannot type before any key is sent, so a replace never empties the field for nothing', async () => {
    const { surface, fake } = await launched({}, { options: { headed: true } });
    for (const text of ['é'.repeat(5_001), 'a\0b']) {
      await expect(surface.typeText(text, { replace: true }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    }
    expect(actions(fake.calls()).filter((key) => key !== 'snapshot')).toEqual([]);
    // At the limit is fine.
    await surface.typeText('a'.repeat(10_000), { replace: false }, operation());
    expect(fake.calls().filter((call) => call.key === 'type')).toHaveLength(1);
  });

  it("waits out settle after an agent's key press, as after its other actions", async () => {
    const { surface } = await launched({}, { options: { headed: true, settle: 600 } });
    const started = Date.now();
    await surface.pressKey('Tab', operation('agent'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
  });

  it('sends no delete when select all moved focus off the field, so it never reaches another control', async () => {
    const form = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    // After Cmd+A the app moved focus from Username to the Sign in button.
    const moved = JSON.parse(
      JSON.stringify(form)
        .replace('"states":["focused"]', '"states":[]')
        .replace('"native_id":{"kind":"ax_identifier","value":"sign-in"}', '"native_id":{"kind":"ax_identifier","value":"sign-in"},"states":["focused"]'),
    ) as unknown;
    const { surface, fake } = await launched({ snapshot: [form, form, form, moved] }, { options: { headed: true } });
    await expect(surface.typeText('ada', { replace: true }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringMatching(/lost keyboard focus after select all/) });
    expect(fake.calls().filter((call) => call.key === 'press').map((call) => call.args[1])).toEqual(['cmd+a']);
    expect(fake.calls().some((call) => call.key === 'type')).toBe(false);
  });

  it('reports a type after a clear that changed the field as possibly committed', async () => {
    const { surface } = await launched({ type: [failure('STALE_REF', 'not_delivered')] });
    await expect(surface.typeText('ada', { replace: true }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  });

  it('unchecks a mixed checkbox, whose state is neither checked nor unchecked', async () => {
    const mixed = JSON.parse(JSON.stringify(snapshotAnswer('macos/appkit-form')).replace('"value":"0"', '"value":"2","states":["indeterminate"]')) as unknown;
    const { surface, fake, byTestId } = await launched({ snapshot: [mixed] });
    await surface.perform(byTestId('remember'), { kind: 'uncheck' }, operation());
    expect(fake.calls().some((call) => call.key === 'uncheck')).toBe(true);
  });

  it('taps a point in the window where it is now, with no observation first', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 300, y: 200, width: 400, height: 300 } }] }] }), { observe: false, options: { headed: true } });
    await surface.performAt({ x: 20, y: 30 }, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args).toEqual(['mouse-click', '--xy=320,230', '--headed']);
  });

  it('gives each read of the launch wait what is left of that wait, not of the whole open', async () => {
    const { fake } = await launched({}, { openTimeoutMs: 60_000, observe: false });
    const read = fake.calls().find((call) => call.key === 'snapshot');
    expect(Number(read?.args[read.args.indexOf('--timeout-ms') + 1])).toBeLessThanOrEqual(10_000);
  });

  it('keeps every node of a screen larger than the binding cap', async () => {
    const buttons = Array.from({ length: 5_000 }, (_, index) => ({ role: 'button', name: `b${index}`, ref_id: `@s1:e${index}` }));
    const big = { ok: true, data: { snapshot_id: 's1', window: { id: 'w-mine' }, tree: { role: 'window', name: 'Big', children: buttons } } };
    const { surface, fake } = await launched({ snapshot: [big] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![0]!.ref, { kind: 'tap' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['click', '@s1:e0']);
  });

  it('takes nothing as its own after a launch agent-desktop refused', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({
      launch: [failure('APP_NOT_FOUND', 'not_delivered')],
      'list-apps': [{ ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toThrow(/no installed app/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('never takes a running copy without its launch token, and says the launch left nothing it could find', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({
      launch: [failure('TIMEOUT', 'delivered_unverified')],
      'list-apps': [{ ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('taps a point in the window it was taken from, even after another window took focus', async () => {
    const windows = (pid: number, first: number) => [
      { id: 'w-mine', pid, process_instance: 'instance-1', is_focused: first === 0, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { id: 'w-other', pid, process_instance: 'instance-1', is_focused: first === 1, bounds: { x: 700, y: 200, width: 400, height: 300 } },
    ];
    const { surface, fake } = await launched((pid) => ({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], 'list-windows': [{ ok: true, data: windows(pid, 0) }, { ok: true, data: windows(pid, 0) }, { ok: true, data: windows(pid, 1) }, { ok: true, data: windows(pid, 0) }] }), { options: { headed: true } });
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    const calls = fake.calls().map((call) => call.args);
    expect(calls.findLast((call) => call[0] === 'focus-window')).toEqual(['focus-window', '--window-id', 'w-mine', '--headed']);
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=110,120', '--headed']);
  });

  it('measures a point in the window a locate read, after a dialog window took over', async () => {
    const windows = (pid: number) => [
      { id: 'w-8032', pid, process_instance: 'instance-1', is_focused: false, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { id: 'w-dialog', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 500, y: 100, width: 300, height: 200 } },
    ];
    const { surface, fake } = await launched((pid) => ({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-dialog')], 'list-windows': [{ ok: true, data: windows(pid) }] }), { options: { headed: true } });
    await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'sign-in', exact: true } } }, operation());
    await surface.performAt({ x: 11.5, y: 16.25 }, { kind: 'tap' }, operation());
    const calls = fake.calls().map((call) => call.args);
    expect(calls.findLast((call) => call[0] === 'focus-window')).toEqual(['focus-window', '--window-id', 'w-dialog', '--headed']);
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=511.5,116.25', '--headed']);
  });

  it('taps a point in the window a test chose after a read of another one', async () => {
    const windows = (pid: number, panel = false) => [
      { id: 'w-8032', pid, process_instance: 'instance-1', is_focused: !panel, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      { id: 'w-panel', pid, process_instance: 'instance-1', is_focused: panel, bounds: { x: 600, y: 100, width: 300, height: 200 } },
    ];
    // The panel has focus once it is brought forward, the fifth listing.
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [...Array.from({ length: 4 }, () => ({ ok: true, data: windows(pid) })), { ok: true, data: windows(pid, true) }] }), { options: { headed: true } });
    await surface.locate({ kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'sign-in', exact: true } } }, operation());
    await surface.useWindow('w-panel', signal, 5_000);
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    const calls = fake.calls().map((call) => call.args);
    expect(calls.findLast((call) => call[0] === 'focus-window')).toEqual(['focus-window', '--window-id', 'w-panel', '--headed']);
    expect(calls.at(-1)).toEqual(['mouse-click', '--xy=610,120', '--headed']);
  });

  it('refuses a point when another window took focus as the target came forward, since the click carries no window', async () => {
    const windows = (pid: number, sheet: boolean) => [
      { id: 'w-mine', pid, process_instance: 'instance-1', is_focused: !sheet, bounds: { x: 100, y: 100, width: 400, height: 300 } },
      ...(sheet ? [{ id: 'w-sheet', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 100, y: 120, width: 400, height: 200 } }] : []),
    ];
    const { surface, fake } = await launched((pid) => ({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], 'list-windows': [{ ok: true, data: windows(pid, false) }, { ok: true, data: windows(pid, false) }, { ok: true, data: windows(pid, false) }, { ok: true, data: windows(pid, true) }] }), { options: { headed: true } });
    await expect(surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/another window took focus/) });
    expect(fake.calls().some((call) => call.key === 'mouse-click')).toBe(false);
  });

  it('measures a point from where the window is once it was brought forward', async () => {
    const at = (pid: number, x: number) => ({ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true, bounds: { x, y: 200, width: 400, height: 300 } }] });
    const { surface, fake } = await launched((pid) => ({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')], 'list-windows': [at(pid, 100), at(pid, 100), at(pid, 100), at(pid, 500)] }), { options: { headed: true } });
    await surface.performAt({ x: 10, y: 20 }, { kind: 'tap' }, operation());
    expect(fake.calls().map((call) => call.args).at(-1)).toEqual(['mouse-click', '--xy=510,220', '--headed']);
  });

  it('refuses a point outside the window, which would land on another app', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true, bounds: { x: 100, y: 100, width: 100, height: 100 } }] }] }), { observe: false, options: { headed: true } });
    await expect(surface.performAt({ x: 115, y: 20 }, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().some((call) => call.key === 'mouse-click')).toBe(false);
  });

  it('reports an option select cannot find as missing', async () => {
    const { surface, fake, byTestId } = await launched({ select: [failure('ELEMENT_NOT_FOUND', 'not_delivered')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/no option "Team"/) });
    expect(actions(fake.calls())).toEqual(['snapshot', 'snapshot', 'select']);
  });

  it('scrolls the window as it is now on a root swipe, not the container of an older observation', async () => {
    const screen = (id: string) => ({ ok: true, data: { snapshot_id: id, window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ role: 'scrollarea', name: id, ref_id: `@${id}:e1` }] } } });
    const { surface, fake } = await launched({ snapshot: [screen('s1'), screen('s1'), screen('s2')] });
    await surface.perform({ id: 'root', revision: '' }, { kind: 'swipe', direction: 'down' }, operation());
    expect(fake.calls().at(-1)?.args.slice(0, 2)).toEqual(['scroll', '@s2:e1']);
  });

  it.skipIf(process.platform !== 'darwin')('launches the appPath build even with a bundleId set, and refuses a bundleId that is not its own', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-bundle-'));
    const bundle = path.join(directory, 'Built.app');
    mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
    writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }] });
      const init = (bundleId: string) =>
        tracked(new DesktopSurface(resolveOptions({ binary: fake.binary }), 'macos')).init({ runId: 'r', targetName: 'mac', projectRoot: directory, app: { appPath: 'Built.app', bundleId }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await expect(init('dev.e2e.built')).resolves.toBeUndefined();
      await expect(init('com.example.other')).rejects.toThrow(/is not the CFBundleIdentifier "dev.e2e.built"/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('opens an appPath build by its path in the background, takes the copy carrying its token, and quits it', async () => {
    const { surface, fake, bundle, recorded } = await appPathSurface(
      // As LaunchServices does: a process with the one variable `--env` names.
      `while [ $# -gt 0 ]; do [ "$1" = "--env" ] && variable="$2"; shift; done\nenv "$variable" ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)' >/dev/null 2>&1 &\necho $! >> "$SPAWNED"\n`,
    );
    await surface.restart(operation());
    const args = readFileSync(recorded, 'utf8').trimEnd().split('\n');
    expect(args).toEqual(['-g', '-n', '--env', expect.stringMatching(/^E2E_DESKTOP_LAUNCH=[\w-]+$/), realpathSync(bundle), '--args', '-ApplePersistenceIgnoreState', 'YES']);
    const opened = fake.spawned().at(-1)!;
    expect((await surface.observe(operation(), undefined)).root.children?.some((node) => node.testId === 'username')).toBe(true);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(opened)).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('never brings a background app that opens no window forward, and says it needs headed', async () => {
    const { surface, recorded } = await appPathSurface(
      `while [ $# -gt 0 ]; do [ "$1" = "--env" ] && variable="$2"; shift; done\nenv "$variable" ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)' >/dev/null 2>&1 &\necho $! >> "$SPAWNED"\n`,
      { 'list-windows': [{ ok: true, data: [] }] },
    );
    await expect(surface.restart({ ...operation(), timeoutMs: 15_000 })).rejects.toThrow(/opened no window.*desktop\(\{ headed: true \}\)/);
    // The one `open` was the background launch: no second one by path brought the app, or another copy of it, forward.
    expect(readFileSync(recorded, 'utf8').split('\n')[0]).toBe('-g');
  });

  it("launches the app in the foreground when the run asks for --headed, though the target's desktop() is not headed", async () => {
    const { fake } = await launched({}, { runHeaded: true, observe: false });
    expect(fake.calls().find((call) => call.key === 'launch')?.args).toContain('--activate');
    const { fake: background } = await launched({}, { observe: false });
    expect(background.calls().find((call) => call.key === 'launch')?.args).not.toContain('--activate');
  });

  it.skipIf(process.platform !== 'darwin')('opens an appPath build in the foreground when the run asks for --headed', async () => {
    const { surface, recorded } = await appPathSurface(
      `while [ $# -gt 0 ]; do [ "$1" = "--env" ] && variable="$2"; shift; done\nenv "$variable" ${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)' >/dev/null 2>&1 &\necho $! >> "$SPAWNED"\n`,
      {},
      true,
    );
    await surface.restart(operation());
    expect(readFileSync(recorded, 'utf8').split('\n')).not.toContain('-g');
  });

  it.skipIf(process.platform !== 'darwin')("launches a bundleId target by its id, not the appPath build an earlier host on the same handle named", async () => {
    const { surface, fake, recorded } = await appPathSurface('exit 1\n');
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await surface.init({ runId: 'r2', targetName: 'mac', projectRoot: process.cwd(), app: { bundleId: 'dev.e2e.spike.form' }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await surface.restart(operation()).catch(() => undefined);
    expect(existsSync(recorded)).toBe(false);
    expect(fake.calls().some((call) => call.key === 'launch')).toBe(true);
  });

  it.skipIf(process.platform !== 'darwin')('reports an open cancelled while it ran as cancelled', async () => {
    const { surface } = await appPathSurface('sleep 5\n');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await expect(surface.restart({ ...operation(), signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.skipIf(process.platform !== 'darwin')('reports an open LaunchServices refused as a failure that started nothing', async () => {
    const { surface } = await appPathSurface(`echo 'The application cannot be opened because its executable is missing.' >&2\nexit 1\n`);
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ENGINE_FAILURE', message: expect.stringMatching(/its executable is missing\.$/) });
    // Nothing to look for at the end of the attempt: no wait, no second error.
    const started = Date.now();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('keeps the ids of one window while another window is read', async () => {
    const { surface, byTestId } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), renamed('macos/appkit-form', 'w-8032', 'w-other'), snapshotAnswer('macos/appkit-form')] });
    const signIn = byTestId('sign-in');
    await surface.observe(operation(), undefined);
    const back = await surface.observe(operation(), undefined);
    expect(back.root.children?.find((node) => node.testId === 'sign-in')?.ref.id).toBe(signIn.id);
  });

  it('keeps the launch wait within its time when each read of it is slow', async () => {
    const started = Date.now();
    await expect(launched({ 'list-windows': [{ ok: true, data: [], sleepMs: 2_000 }] }, { openTimeoutMs: 3_000, observe: false })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(4_500);
  });

  it('presses a key into a control only while it holds focus, and into its own window', async () => {
    const { surface, fake, byTestId } = await launched({ snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')] });
    await surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'return', '--window-id', 'w-mine']);
    await expect(surface.perform(byTestId('sign-in'), { kind: 'press', key: 'Enter' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().filter((call) => call.key === 'press')).toHaveLength(1);
  });

  it('sends no key when focusing the control fails', async () => {
    const { surface, fake, byTestId } = await launched({ focus: [failure('ACTION_NOT_SUPPORTED', 'not_delivered')] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('reports a read that went stale after the press focused the control as possibly committed, so it is not retried and focused again', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    // The launch's read and the observation, then the read after the focus.
    const form = renamed('macos/appkit-form', 'w-8032', 'w-mine');
    const { surface, fake, byTestId } = await launched({ snapshot: [form, form, hidden] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Tab' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
    expect(fake.calls().filter((call) => call.key === 'focus')).toHaveLength(1);
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('reports a select agent-desktop could not find the option of, but may have delivered, as possibly committed', async () => {
    const { surface, byTestId } = await launched({ select: [failure('ELEMENT_NOT_FOUND', 'delivered_unverified')] });
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', retryable: false });
  });

  it('never types a missing option into an editable combo box as free text: a select there is refused, and nothing is sent', async () => {
    // agent-desktop's select sets an editable combo box's value and reads it back, which any text passes.
    const editable = { ok: true, data: { snapshot_id: 's5', window: { id: 'w-mine' }, tree: { role: 'window', name: 'Form', children: [{ role: 'combobox', name: 'Plan', ref_id: '@s5:e1', available_actions: ['Click', 'SetValue', 'SetFocus'] }] } } };
    const { surface, fake } = await launched({ snapshot: [editable] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![0]!.ref, { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringMatching(/editable.*fill\(\)/) });
    expect(fake.calls().some((call) => call.key === 'select' || call.key === 'set-value')).toBe(false);
  });

  it('reads the next window when the focused-first one is a panel accessibility cannot read', async () => {
    const hidden = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'not exposed', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const { surface, fake } = await launched(
      (pid) => ({
        'list-windows': [{ ok: true, data: [{ id: 'w-panel', pid, process_instance: 'instance-1', visible: true }, { id: 'w-doc', pid, process_instance: 'instance-1', visible: true }] }],
        snapshot: [hidden, snapshotAnswer('macos/appkit-form')],
      }),
      { observe: false },
    );
    const observed = await surface.observe(operation(), undefined);
    expect(observed.root.children?.length).toBeGreaterThan(0);
    expect(fake.calls().filter((call) => call.key === 'snapshot').map((call) => call.args[2])).toEqual(expect.arrayContaining(['w-panel', 'w-doc']));
  });

  it.skipIf(process.platform === 'win32')('refuses a launch that agent-desktop says handed over to a copy already running', async () => {
    const theirs = otherCopy();
    const { surface } = await initialized({ launch: [{ ok: true, data: { app: 'SpikeForm', pid: theirs, process_instance: 'theirs' } }] });
    await expect(surface.restart(operation())).rejects.toThrow(/handed over to a copy already running/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('types keystrokes into the focused field, which only physical input sends', async () => {
    const { surface, fake } = await launched({}, { options: { headed: true } });
    await surface.typeText('ada', { replace: false }, operation());
    expect(fake.calls().find((call) => call.key === 'type')?.args).toContain('--headed');
  });

  it('fails doctor on an appPath that is no app bundle', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-empty-'));
    mkdirSync(path.join(directory, 'Empty.app'));
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' }, screen_recording: { state: 'granted' } } } }] });
      const surface = tracked(new DesktopSurface(resolveOptions({ binary: fake.binary }), 'macos'));
      const checks = await surface.doctor({ targetName: 'mac', projectRoot: directory, app: { appPath: 'Empty.app' }, env: fake.env, headed: false, signal, log: () => undefined });
      expect(checks.find((check) => check.id === 'app-path')).toMatchObject({ status: 'fail', message: expect.stringMatching(/no Contents\/Info.plist/) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'darwin')('fails doctor on a bundle init would refuse: no bundle id, or not the target\'s', async () => {
    const directory = artifacts();
    const plist = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${body}</dict></plist>`;
    for (const [name, body] of [['Anonymous.app', ''], ['Built.app', '<key>CFBundleIdentifier</key><string>dev.e2e.built</string>']] as const) {
      mkdirSync(path.join(directory, name, 'Contents'), { recursive: true });
      writeFileSync(path.join(directory, name, 'Contents', 'Info.plist'), plist(body));
    }
    const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' }, screen_recording: { state: 'granted' } } } }] });
    const surface = tracked(new DesktopSurface(resolveOptions({ binary: fake.binary }), 'macos'));
    const appPath = async (app: { appPath: string; bundleId?: string }) => (await surface.doctor({ targetName: 'mac', projectRoot: directory, app, env: fake.env, headed: false, signal, log: () => undefined })).find((check) => check.id === 'app-path');
    expect(await appPath({ appPath: 'Anonymous.app' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/declares no CFBundleIdentifier/) });
    expect(await appPath({ appPath: 'Built.app', bundleId: 'com.example.other' })).toMatchObject({ status: 'fail', message: expect.stringMatching(/is not the CFBundleIdentifier "dev.e2e.built"/) });
    expect(await appPath({ appPath: 'Built.app', bundleId: 'dev.e2e.built' })).toMatchObject({ status: 'pass' });
  });

  it.skipIf(process.platform !== 'darwin')('opens no app bundle once the operation budget is spent', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-bundle-'));
    mkdirSync(path.join(directory, 'Built.app', 'Contents'), { recursive: true });
    writeFileSync(path.join(directory, 'Built.app', 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.e2e.built</string></dict></plist>');
    try {
      const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }] });
      const surface = tracked(new DesktopSurface(resolveOptions({ binary: fake.binary }), 'macos'));
      await surface.init({ runId: 'r', targetName: 'mac', projectRoot: directory, app: { appPath: 'Built.app' }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
      await expect(surface.restart({ ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('presses a key into one of two look-alike fields, found again by its place', async () => {
    const field = (ref: string, y: number, focused: boolean) => ({ role: 'textfield', name: 'Item', ref_id: ref, bounds: { x: 10, y, width: 100, height: 20 }, ...(focused ? { states: ['focused'] } : {}) });
    const screen = (id: string, focusSecond: boolean) => ({ ok: true, data: { snapshot_id: id, window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [field(`@${id}:e1`, 10, false), field(`@${id}:e2`, 40, focusSecond)] } } });
    const { surface, fake } = await launched({ snapshot: [screen('s1', false), screen('s1', false), screen('s2', true)] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation());
    expect(fake.calls().at(-1)?.args).toEqual(['press', 'a', '--window-id', 'w-mine']);
  });

  it('sends no key when a twin went as the field was focused, so the other could have taken its place', async () => {
    const field = (ref: string, y: number, focused: boolean) => ({ role: 'textfield', name: 'Item', ref_id: ref, bounds: { x: 10, y, width: 100, height: 20 }, ...(focused ? { states: ['focused'] } : {}) });
    const both = { ok: true, data: { snapshot_id: 's1', window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [field('@s1:e1', 10, false), field('@s1:e2', 40, false)] } } };
    // The focus handler removed the second field, and the first moved into its place and took focus.
    const one = { ok: true, data: { snapshot_id: 's2', window: { id: 'w-mine' }, tree: { role: 'window', name: 'List', bounds: { x: 0, y: 0, width: 200, height: 200 }, children: [field('@s2:e1', 40, true)] } } };
    const { surface, fake } = await launched({ snapshot: [both, both, one] }, { observe: false });
    const observed = await surface.observe(operation(), undefined);
    await expect(surface.perform(observed.root.children![1]!.ref, { kind: 'press', key: 'a' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('refuses a key agent-desktop cannot press before it moves focus', async () => {
    const { surface, fake, byTestId } = await launched({});
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Insert' }, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(fake.calls().some((call) => call.key === 'focus')).toBe(false);
  });

  it('keeps a launch whose process it could not look for, so the next quit looks again', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: true, ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      'list-apps': [{ ok: true, data: { apps: [] } }, failure('INTERNAL', 'not_delivered'), { spawnedApps: { name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form' } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 5_000 })).rejects.toThrow(/list apps/);
    await surface.dispose({ signal, timeoutMs: 5_000 });
    expect(await gone(fake.spawned()[0]!)).toBe(true);
  });

  it('never reads a window row that names the launched pid but no process instance', async () => {
    const { surface, fake } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-anon', pid, is_focused: true }] }] }));
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(fake.calls().some((call) => call.args.includes('w-anon'))).toBe(false);
  });

  it('accepts the process agent-desktop launched when its environment cannot be read, as for a system app', async () => {
    const hidden = 2_147_483_000;
    const { surface } = await initialized({
      launch: [{ ok: true, data: { app: 'SpikeForm', pid: hidden, process_instance: 'instance-1' } }],
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid: hidden, process_instance: 'instance-1', is_focused: true }] }],
      'list-apps': [{ ok: true, data: { apps: [] } }],
    });
    await expect(surface.restart(operation())).resolves.toBeUndefined();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  it('reads the whole window for a screenshot even with interactive snapshots', async () => {
    const { surface, fake } = await launched({ snapshot: [renamed('macos/sign-in-form', 'w-8321', 'w-mine')] }, { options: { snapshot: 'interactive' } });
    await startAttempt(surface);
    await surface.screenshot('shot', operation()).catch(() => undefined);
    const reads = fake.calls().filter((call) => call.key === 'snapshot');
    expect(reads.at(-1)?.args).not.toContain('-i');
    expect(reads.some((call) => call.args.includes('-i'))).toBe(true);
  });

  it('quits the process it launched at the end of the attempt, and only that one', async () => {
    const { surface, app, fake } = await launched({});
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(app.pid)).toBe(true);
    expect(fake.calls().some((call) => call.key === 'close-app')).toBe(false);
  });
  it('gives agent-desktop and the app it launches only a few variables of the run', async () => {
    const { fake, app } = await launched({});
    for (const call of fake.calls()) {
      expect(call.envNames).not.toContain('E2E_PROBE_SECRET');
      expect(call.envNames).toContain('AGENT_DESKTOP_HOME');
    }
    const environment = await environmentOf(app.pid);
    expect(environment).toMatch(/E2E_DESKTOP_LAUNCH=/);
    expect(environment).not.toMatch(/E2E_PROBE_SECRET/);
  });

  it('brings the app forward at launch only with physical input on', async () => {
    const { fake } = await launched({}, { options: { headed: true } });
    expect(fake.calls().find((call) => call.key === 'launch')?.args).toContain('--activate');
  });

  it('takes no copy whose environment cannot be read after a failed launch, not even the one new copy', async () => {
    const theirs = unreadableCopy();
    const { surface, fake } = await initialized({
      launch: [{ spawn: 'unreadable', ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      // The copy that started after the list before the launch may be the developer's: being new shows nothing.
      'list-apps': [
        { ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } },
        { spawnedApps: { name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form' }, alsoRunning: [theirs] },
      ],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(fake.spawned()[0]!, 300)).toBe(false);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('refuses an appPath to a macOS app, whose launch token cannot be read', async () => {
    const fake = fakeScenario({ status: [{ ok: true, data: { version: '1.3.1', permissions: { accessibility: { state: 'granted' } } } }] });
    const surface = tracked(new DesktopSurface(resolveOptions({ binary: fake.binary, settle: false }), 'macos'));
    const init = surface.init({ runId: 'r', targetName: 'mac', projectRoot: artifacts(), app: { appPath: '/System/Applications/Calculator.app' }, env: fake.env, headed: false, workerSlot: 0, signal, log: () => undefined });
    await expect(init).rejects.toThrow(/macOS hides.*set app\.bundleId "com\.apple\.calculator"/);
  });

  it('takes no copy whose environment cannot be read when the copies before the launch are unknown', async () => {
    const theirs = unreadableCopy();
    const { surface } = await initialized({
      launch: [failure('TIMEOUT', 'delivered_unverified')],
      'list-apps': [
        { ok: true, data: { apps: [], complete: false } },
        { ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } },
      ],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('takes no single new copy whose environment cannot be read from a list that left copies out', async () => {
    const theirs = unreadableCopy();
    const { surface } = await initialized({
      launch: [failure('TIMEOUT', 'delivered_unverified')],
      'list-apps': [
        { ok: true, data: { apps: [] } },
        { ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }], complete: false } },
      ],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/only in part/);
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('refuses a launch agent-desktop reports for a process it cannot show is new', async () => {
    const theirs = unreadableCopy();
    const { surface } = await initialized({
      launch: [{ ok: true, data: { app: 'SpikeForm', pid: theirs, process_instance: 'theirs' } }],
      'list-apps': [{ ok: true, data: { apps: [], complete: false } }],
    });
    await expect(surface.restart(operation())).rejects.toThrow(/cannot be shown to be this launch's/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('lists the running copies the way agent-desktop matches the app, its localized name too', async () => {
    const theirs = unreadableCopy();
    const { surface, fake } = await initialized({
      launch: [{ ok: true, data: { app: '계산기', pid: theirs, process_instance: 'theirs' } }],
      'list-apps': [{ ok: true, data: { apps: [{ name: '계산기', bundle_id: 'com.apple.calculator', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toThrow(/handed over to a copy already running/);
    expect(fake.calls().find((call) => call.key === 'list-apps')?.args.slice(0, 3)).toEqual(['list-apps', '--app', 'dev.e2e.spike.form']);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('takes neither of two new copies whose environment cannot be read', async () => {
    const first = unreadableCopy();
    const second = unreadableCopy();
    const { surface } = await initialized({
      launch: [failure('TIMEOUT', 'delivered_unverified')],
      'list-apps': [
        { ok: true, data: { apps: [] } },
        { ok: true, data: { apps: [first, second].map((pid) => ({ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid, process_instance: `p${pid}` })) } },
      ],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
    expect(await gone(first, 300)).toBe(false);
    expect(await gone(second, 300)).toBe(false);
  });

  it('refuses a launch agent-desktop reports for a copy that ran before it, even one whose environment cannot be read', async () => {
    const theirs = unreadableCopy();
    const { surface } = await initialized({
      launch: [{ ok: true, data: { app: 'SpikeForm', pid: theirs, process_instance: 'theirs' } }],
      'list-apps': [{ ok: true, data: { apps: [{ name: 'SpikeForm', bundle_id: 'dev.e2e.spike.form', pid: theirs, process_instance: 'theirs' }] } }],
    });
    await expect(surface.restart(operation())).rejects.toThrow(/handed over to a copy already running/);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(await gone(theirs, 300)).toBe(false);
  });

  it('leaves nothing to look for after an open whose budget ran out before it launched', async () => {
    const { surface, fake } = await initialized({});
    await expect(surface.restart({ ...operation(), timeoutMs: 0 })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    const started = Date.now();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(fake.calls().some((call) => call.key === 'launch')).toBe(false);
  });

  it('keeps a launch whose lookup ran out of time, so the next quit looks again', async () => {
    // A copy whose environment cannot be read, so no token search finds it: only a lookup that answers settles the launch.
    const { surface } = await initialized({
      launch: [{ spawn: 'unreadable', ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      'list-apps': [{ ok: true, data: { apps: [] } }, { sleepMs: 3_000, ok: true, data: { apps: [] } }, { ok: true, data: { apps: [] } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await expect(surface.endAttempt({ signal, timeoutMs: 1_000 })).rejects.toThrow(/ran out of time/);
    await expect(surface.dispose({ signal, timeoutMs: 1_000 })).rejects.toThrow(/no process it started was found/);
  });

  it('reads only the window a test chose, until it goes back to the focused one', async () => {
    const { surface, fake } = await launched((pid) => ({
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1', is_focused: false }] }],
    }));
    await expect(surface.useWindow('w-gone', signal, 5_000)).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    await surface.useWindow('w-panel', signal, 5_000);
    await surface.observe(operation(), undefined);
    expect(fake.calls().findLast((call) => call.key === 'snapshot')?.args).toEqual(expect.arrayContaining(['--window-id', 'w-panel']));
    await surface.useWindow(undefined, signal, 5_000);
    await surface.observe(operation(), undefined);
    expect(fake.calls().findLast((call) => call.key === 'snapshot')?.args).toEqual(expect.arrayContaining(['--window-id', 'w-mine']));
  });

  it('fails the open of an app that quit right after it launched, and brings nothing forward', async () => {
    const started = Date.now();
    await expect(
      launched({ launch: [{ spawn: true, exits: true, ok: true, data: { app: 'SpikeForm', pid: SPAWNED, process_instance: 'instance-1' } }], 'list-windows': [{ ok: true, data: [] }] }, { observe: false }),
    ).rejects.toThrow(/quit right after it launched/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('acts on no node read in another window than the one a test chose', async () => {
    const { surface, fake, byTestId } = await launched((pid) => ({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1' }] }],
    }));
    await surface.useWindow('w-panel', signal, 5_000);
    await expect(surface.perform(byTestId('sign-in'), { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    expect(fake.calls().some((call) => call.key === 'click')).toBe(false);
  });

  it('refuses to read a chosen window that closed between the list and the read', async () => {
    const { surface } = await launched((pid) => ({
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1' }] }],
      snapshot: [snapshotAnswer('macos/appkit-form'), snapshotAnswer('macos/appkit-form'), failure('WINDOW_NOT_FOUND', 'not_delivered')],
    }));
    await surface.useWindow('w-panel', signal, 5_000);
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/useWindow\(\) chose/) });
  });

  it('reads no empty screen from an app whose windows accessibility cannot read, and lets a locator read again', async () => {
    const unreadable = { ok: false, error: { code: 'ACTION_NOT_SUPPORTED', message: 'no accessibility element', details: { kind: 'window_without_accessibility_element' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const { surface } = await launched({ snapshot: [snapshotAnswer('macos/appkit-form'), unreadable] }, { observe: false });
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/could be read/) });
    await expect(surface.observe(operation(), undefined)).rejects.toMatchObject({ code: 'NODE_STALE' });
  });

  it('reads no empty screen from an app that quit while another process took over its id', async () => {
    const { surface } = await launched((pid) => ({
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [{ id: 'w-new', pid, process_instance: 'instance-2', is_focused: true }] }],
      'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [{ name: 'SpikeForm', pid, process_instance: 'instance-2' }] } }],
    }), { observe: false });
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/quit/) });
  });

  it('reads no empty screen from an app that quit', async () => {
    const { surface, app } = await launched((pid) => ({ 'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] }, { ok: true, data: [] }] }), { observe: false });
    process.kill(app.pid, 'SIGKILL');
    expect(await gone(app.pid)).toBe(true);
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/quit/) });
  });

  it('refuses to read a chosen window once it closed, rather than show an empty screen', async () => {
    const { surface } = await launched((pid) => ({
      'list-windows': [
        { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1' }] },
        { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1' }] },
        { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }, { id: 'w-panel', pid, process_instance: 'instance-1' }] },
        { ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: true }] },
      ],
    }));
    await surface.useWindow('w-panel', signal, 5_000);
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'INVALID_STATE', message: expect.stringMatching(/useWindow\(\) chose/) });
    await expect(surface.pressKey('Enter', operation())).rejects.toThrow(/useWindow\(\) chose/);
  });

  it('tells doctor the pinned release is not there yet when the cache holds no checked copy', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'e2e-desktop-doctor-'));
    try {
      const env = { HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') };
      // An executable an older version unpacked, which no verified unpack stamped.
      const executable = pinnedExecutable(env)!;
      mkdirSync(path.dirname(executable), { recursive: true });
      writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
      const surface = tracked(new DesktopSurface(resolveOptions({}), 'macos'));
      const checks = await surface.doctor({ targetName: 'mac', projectRoot: home, app: { bundleId: 'com.example.app' }, env, headed: false, signal, log: () => undefined });
      expect(checks.find((check) => check.id === 'agent-desktop')).toMatchObject({ status: 'warn', message: expect.stringMatching(/run e2e doctor again/) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('sends a key to an app in the background only to its own window, never by its name', async () => {
    const unconfirmed = { ok: false, error: { code: 'STALE_REF', message: 'focus unconfirmed', details: { cause: 'exact_window_focus_unconfirmed' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const { surface, fake, byTestId } = await launched({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      press: [unconfirmed],
    });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Tab' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringMatching(/headed: true/) });
    await expect(surface.pressKey('Enter', operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
    expect(fake.calls().filter((call) => call.key === 'press').map((call) => call.args)).toEqual([
      ['press', 'tab', '--window-id', 'w-mine'],
      ['press', 'return', '--window-id', 'w-mine'],
    ]);
  });

  it('closes the menu a select of a missing option left open, and names the option it may lack', async () => {
    const { surface, fake, byTestId } = await launched((pid) => ({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      select: [failure('APP_UNRESPONSIVE', 'delivered_unverified')],
      'list-surfaces': [{ ok: true, data: { pid, surfaces: [{ type: 'context_menu' }] } }, { ok: true, data: { pid, surfaces: [] } }],
    }));
    // A menu left open shows neither the option missing nor nothing chosen: the failure stays one that may have committed.
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Enterprise' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringMatching(/whether "Enterprise" was chosen is unknown; the list may have no option "Enterprise"/) });
    expect(fake.calls().find((call) => call.key === 'select')?.args).toEqual(expect.arrayContaining(['--timeout-ms', '3000']));
    expect(fake.calls().filter((call) => call.key === 'press').map((call) => call.args[1])).toEqual(['escape']);
  });

  it("reports the select's own failure when closing the menu it left open fails", async () => {
    const unconfirmed = { ok: false, error: { code: 'STALE_REF', message: 'focus unconfirmed', details: { cause: 'exact_window_focus_unconfirmed' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const theirs = otherCopy();
    const { surface, byTestId } = await launched((pid) => ({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      select: [failure('TIMEOUT', 'delivered_unverified')],
      press: [unconfirmed],
      'list-surfaces': [{ ok: true, data: { pid, surfaces: [{ type: 'context_menu' }] } }],
      'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [{ name: 'SpikeForm', pid: theirs, process_instance: 'theirs' }, { name: 'SpikeForm', pid, process_instance: 'instance-1' }] } }],
    }));
    // In the background no key reaches the app, so the menu stays open, and the error says so.
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED', message: expect.stringMatching(/menu is still open: the app's window is not the active one, so no Escape could be sent.*headed: true/) });
  });

  it('says no Escape was sent, not that Escape failed, when the run is --headed but the window is not active', async () => {
    const unconfirmed = { ok: false, error: { code: 'STALE_REF', message: 'focus unconfirmed', details: { cause: 'exact_window_focus_unconfirmed' }, disposition: { delivery: 'not_delivered', retry: 'safe' } } };
    const { surface, byTestId } = await launched(
      (pid) => ({
        snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
        select: [failure('TIMEOUT', 'delivered_unverified')],
        press: [unconfirmed],
        'list-surfaces': [{ ok: true, data: { pid, surfaces: [{ type: 'context_menu' }] } }],
      }),
      { runHeaded: true },
    );
    const failed = await surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation()).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(failed?.message).toMatch(/no Escape could be sent.*headed: true/);
    expect(failed?.message).not.toMatch(/Escape did not close it/);
  });

  it('never says the menu was closed when agent-desktop could not check the window for one', async () => {
    const { surface, byTestId } = await launched((pid) => ({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      select: [failure('APP_UNRESPONSIVE', 'delivered_unverified')],
      'list-surfaces': [{ ok: true, data: { pid, surfaces: [{ type: 'context_menu' }] } }, { ok: true, data: { pid, surfaces: [{ type: 'window', unclassified: ['menu'] }] } }],
    }));
    const failed = await surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Enterprise' }, operation()).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(failed?.message).not.toMatch(/The menu was closed|menu is still open/);
    expect(failed?.message).toMatch(/whether it closed could not be told/);
  });

  it('reports a select that may have chosen something when no menu is left open', async () => {
    const { surface, byTestId } = await launched((pid) => ({
      select: [failure('TIMEOUT', 'delivered_unverified')],
      'list-surfaces': [{ ok: true, data: { pid, surfaces: [] } }],
    }));
    await expect(surface.perform(byTestId('plan'), { kind: 'selectOption', value: 'Team' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it("sends no key into a window that cannot be shown to be the app's key window", async () => {
    const { surface, fake, byTestId } = await launched((pid) => ({
      snapshot: [renamed('macos/appkit-form', 'w-8032', 'w-mine')],
      'list-windows': [{ ok: true, data: [{ id: 'w-mine', pid, process_instance: 'instance-1', is_focused: false }, { id: 'w-panel', pid, process_instance: 'instance-1', is_focused: true }] }],
    }));
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation())).rejects.toThrow(/key window/);
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('sends no key when another control in the same place holds focus', async () => {
    const form = renamed('macos/sign-in-form', 'w-8321', 'w-mine');
    const swapped = JSON.parse(JSON.stringify(form).replace('"name":"Username"', '"name":"Search"').replace('"value":"username"', '"value":"search"')) as unknown;
    const { surface, fake, byTestId } = await launched({ snapshot: [form, form, swapped] });
    await expect(surface.perform(byTestId('username'), { kind: 'press', key: 'Enter' }, operation())).rejects.toThrow(/did not keep keyboard focus/);
    expect(fake.calls().some((call) => call.key === 'press')).toBe(false);
  });

  it('reads a window as deep as desktop({ maxDepth }) says', async () => {
    const { fake } = await launched({}, { options: { maxDepth: 64 } });
    const snapshot = fake.calls().find((call) => call.key === 'snapshot')!.args;
    expect(snapshot[snapshot.indexOf('--max-depth') + 1]).toBe('64');
  });

  it('refuses a placeholder query, which macOS gives nothing to match', async () => {
    const { surface } = await launched({}, { observe: false, snapshot: 'macos/sign-in-form' });
    const placeholder = { kind: 'query', query: { kind: 'placeholder', value: { kind: 'string', value: 'Username', exact: true } } } as const;
    await expect(surface.locate(placeholder, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const textbox = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true } } } as const;
    const scoped = { kind: 'filter', source: textbox, has: placeholder } as const;
    await expect(surface.locate(scoped, operation())).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    const named = { kind: 'query', query: { kind: 'role', value: { kind: 'string', value: 'textbox', exact: true }, name: { kind: 'string', value: 'Username', exact: true } } } as const;
    await expect(surface.locate(named, operation())).resolves.toHaveLength(1);
  });

  it('counts no matches in a window read in part, and lets the locator read again', async () => {
    const partial = snapshotAnswer('macos/appkit-form') as { ok: true; data: Record<string, unknown> };
    const cut = { ...partial, data: { ...partial.data, complete: false } };
    const { surface } = await launched({ snapshot: [cut, cut, cut, snapshotAnswer('macos/appkit-form')] }, { observe: false });
    const missing = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'nowhere', exact: true } } } as const;
    await expect(surface.locate(missing, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true, message: expect.stringMatching(/read only in part/) });
    const present = { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'username', exact: true } } } as const;
    await expect(surface.locate(present, operation())).rejects.toMatchObject({ code: 'NODE_STALE' });
    await expect(surface.locate(present, operation())).resolves.toHaveLength(1);
  });

  it("keeps the ids of an interactive screen across the whole reads a screenshot's mask takes", async () => {
    const field = { role: 'textfield', name: 'Name', ref_id: '@s:e1', bounds: { x: 10, y: 10, width: 50, height: 20 } };
    const window = { role: 'window', name: 'Form', bounds: { x: 0, y: 0, width: 100, height: 100 } };
    const interactive = { ok: true, data: { snapshot_id: 's', window: { id: 'w-mine' }, tree: { ...window, children: [field] } } };
    const whole = { ok: true, data: { snapshot_id: 's', window: { id: 'w-mine' }, tree: { ...window, children: [{ role: 'group', name: 'Details', children: [field] }] } } };
    const { surface } = await launched(
      {
        snapshot: [interactive, interactive, interactive, whole, whole, interactive],
        screenshot: [{ ok: true, writePng: { width: 100, height: 100 }, data: { scale_factor: 1 } }],
      },
      { observe: false, options: { snapshot: 'interactive' } },
    );
    await startAttempt(surface);
    const before = await surface.observe(operation(), undefined);
    await surface.screenshot('shot', operation());
    const after = await surface.observe(operation(), undefined);
    expect(after.root.children?.[0]?.ref.id).toBe(before.root.children?.[0]?.ref.id);
  });

  it('keeps the launch record of a launch whose process was never found, so the next run can quit it', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: 'unreadable', ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      // A complete list first, then only partial ones: the last answer decides.
      'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [] } }, { ok: true, data: { apps: [], complete: false } }],
    });
    const home = fake.calls()[0]!.home!;
    try {
      await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
      await expect(surface.dispose({ signal, timeoutMs: 1_000 })).rejects.toThrow(/only in part/);
      expect(JSON.parse(readFileSync(path.join(home, 'app.json'), 'utf8'))).toMatchObject({ token: expect.any(String) });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs two overlapping opens one after the other, and leaves no copy running', async () => {
    const { surface, fake } = await initialized((pid) => ({ 'list-apps': [{ ok: true, data: { apps: [] } }, { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }, { ok: true, data: { apps: [] } }, { ok: true, data: { apps: [{ pid, process_instance: 'instance-1' }] } }] }));
    await Promise.all([surface.restart(operation()), surface.restart(operation())]);
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
    expect(fake.spawned()).toHaveLength(2);
    for (const pid of fake.spawned()) expect(await gone(pid)).toBe(true);
  });

  it('quits the process carrying the launch token of a launch the app list never showed', async () => {
    const { surface, fake } = await initialized({
      launch: [{ spawn: true, ...(failure('TIMEOUT', 'delivered_unverified') as object) }],
      'list-apps': [{ ok: true, data: { apps: [] } }],
    });
    await expect(surface.restart(operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
    await surface.endAttempt({ signal, timeoutMs: 1_000 });
    expect(await gone(fake.spawned()[0]!)).toBe(true);
  });

  it('quits the app a killed worker left running, by its launch token, and nothing else', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const left = (token: string) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: { ...process.env, E2E_DESKTOP_LAUNCH: token } });
    const theirs = left('another-token');
    const leaked = left('token-1');
    children.push(theirs, leaked);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const directories = ['token-1', 'token-1'].map(() => mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-')));
    writeFileSync(path.join(directories[0]!, 'owner'), String(dead.pid));
    // Written before the launch: the token alone, since the worker may be killed before it learns the process id.
    writeFileSync(path.join(directories[0]!, 'app.json'), JSON.stringify({ token: 'token-1' }));
    writeFileSync(path.join(directories[1]!, 'owner'), String(dead.pid));
    writeFileSync(path.join(directories[1]!, 'app.json'), JSON.stringify({ pid: theirs.pid, token: 'token-1' }));
    try {
      await initialized({});
      expect(await gone(leaked.pid!)).toBe(true);
      expect(await gone(theirs.pid!, 300)).toBe(false);
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  });

  it("quits the process a killed worker's record names by its id and start, though its environment cannot be read, and not a later one given that id", async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const leaked = unreadableCopy();
    const reused = unreadableCopy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const startOf = (pid: number) => execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
    const records = [
      { token: 'token-1', pid: leaked, started: startOf(leaked) },
      // The id the record names now belongs to a process that started at another time.
      { token: 'token-2', pid: reused, started: 'Thu Jan  1 00:00:00 1970' },
    ];
    const directories = records.map((record) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-'));
      writeFileSync(path.join(directory, 'owner'), String(dead.pid));
      writeFileSync(path.join(directory, 'app.json'), JSON.stringify(record));
      return directory;
    });
    try {
      await initialized({});
      expect(await gone(leaked)).toBe(true);
      expect(await gone(reused, 300)).toBe(false);
      for (const directory of directories) expect(existsSync(directory)).toBe(false);
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  });

  // The Linux lookup reads /proc, which a test cannot make fail; elsewhere it is `ps`.
  it.skipIf(process.platform === 'linux')('keeps the launch record of a killed worker when the process lookup fails, and quits its app at the next sweep', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const leaked = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: { ...process.env, E2E_DESKTOP_LAUNCH: 'token-keep' } });
    children.push(leaked);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const left = mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-'));
    writeFileSync(path.join(left, 'owner'), String(dead.pid));
    writeFileSync(path.join(left, 'app.json'), JSON.stringify({ token: 'token-keep' }));
    writeFileSync(path.join(left, 'fields.json'), '{"text":"typed"}');
    const brokenPs = artifacts();
    writeFileSync(path.join(brokenPs, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${brokenPs}${path.delimiter}${originalPath}`;
      try {
        await initialized({});
      } finally {
        process.env.PATH = originalPath;
      }
      expect(await gone(leaked.pid!, 300)).toBe(false);
      expect(existsSync(path.join(left, 'app.json'))).toBe(true);
      expect(existsSync(path.join(left, 'owner'))).toBe(true);
      expect(existsSync(path.join(left, 'fields.json'))).toBe(false);
      await initialized({});
      expect(await gone(leaked.pid!)).toBe(true);
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('trusts no state directory it cannot show this user wrote: a symlink in the temporary directory is left alone', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const victim = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { env: { ...process.env, E2E_DESKTOP_LAUNCH: 'token-planted' } });
    children.push(victim);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // What another user could put in a shared /tmp: a link named like a state directory, to a record that names a process of this user.
    const planted = artifacts();
    writeFileSync(path.join(planted, 'owner'), String(dead.pid));
    writeFileSync(path.join(planted, 'app.json'), JSON.stringify({ token: 'token-planted' }));
    const link = path.join(tmpdir(), `e2e-agent-desktop-planted-${process.pid}`);
    symlinkSync(planted, link);
    try {
      await initialized({});
      expect(await gone(victim.pid!, 300)).toBe(false);
      expect(existsSync(path.join(planted, 'app.json'))).toBe(true);
    } finally {
      // The link itself, never its target: rmSync on a link to a directory throws on Node 24.8.
      unlinkSync(link);
    }
  });

  it('sweeps a state directory whose launch record was cut short, and starts', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const left = mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-'));
    writeFileSync(path.join(left, 'owner'), String(dead.pid));
    writeFileSync(path.join(left, 'app.json'), '{"pid":');
    try {
      await initialized({});
      expect(existsSync(left)).toBe(false);
    } finally {
      rmSync(left, { recursive: true, force: true });
    }
  });

  it('sweeps the state directories of workers that are gone, and keeps the ones in use', async () => {
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const left = mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-'));
    writeFileSync(path.join(left, 'owner'), String(dead.pid));
    const used = mkdtempSync(path.join(tmpdir(), 'e2e-agent-desktop-'));
    writeFileSync(path.join(used, 'owner'), String(process.pid));
    try {
      await initialized({});
      expect(existsSync(left)).toBe(false);
      expect(existsSync(used)).toBe(true);
    } finally {
      rmSync(left, { recursive: true, force: true });
      rmSync(used, { recursive: true, force: true });
    }
  });
});
