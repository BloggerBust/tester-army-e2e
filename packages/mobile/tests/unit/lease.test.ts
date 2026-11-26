/**
 * `agentDeviceLeases()` against a stubbed daemon driver: the lease it
 * allocates and hands the worker, the environment and home each daemon gets,
 * and the release on every exit path. `lease-daemon.test.ts` covers the stop
 * report against the installed agent-device.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, type LeaseScopedOptions } from 'agent-device';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceReleaseContext, DeviceRequest } from '../../src/index.ts';
import { agentDeviceLeases, type AgentDeviceLeaseRequest } from '../../src/lease/index.ts';
import { ProviderReleaseWarningError } from '../../src/lease/daemon.ts';
import type { DriverRequest } from '../../src/lease/driver.ts';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  releaseLease: vi.fn(async (_stateDir: string, _scope: LeaseScopedOptions, _signal: AbortSignal) => true),
  stop: vi.fn(async (_stateDir: string, _env: NodeJS.ProcessEnv, _leaseId: string | undefined, _label: string, _signal: AbortSignal, _options?: { sessionEnded?: boolean }) => {}),
  heartbeat: vi.fn(),
  stopHeartbeat: vi.fn(async () => {}),
  rm: vi.fn(),
}));
vi.mock('../../src/lease/daemon.ts', async (original) => ({ ...(await original<typeof import('../../src/lease/daemon.ts')>()), startDriver: mocks.start, releaseLease: mocks.releaseLease, stopDriver: mocks.stop }));
vi.mock('../../src/lease/heartbeat.ts', () => ({ LEASE_TTL_MS: 60_000, startHeartbeat: mocks.heartbeat }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  mocks.rm.mockImplementation(fs.rm);
  return { ...fs, rm: mocks.rm };
});

const env = { PATH: '/bin' };
const allocation: AgentDeviceLeaseRequest = {
  env: { CLOUD_USERNAME: 'ada', CLOUD_ACCESS_KEY: 'cloud-key' },
  selectors: { device: 'Google Pixel 9', providerOsVersion: '16.0', providerApp: 'cloud://APP0' },
  summary: 'Google Pixel 9, android 16.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  let leases = 0;
  mocks.start.mockImplementation(async ({ allocate }: DriverRequest) => ({ leaseId: `lease-${++leases}`, tenantId: allocate.tenant, runId: allocate.runId, retainOnClose: true }));
  mocks.releaseLease.mockResolvedValue(true);
  mocks.stop.mockImplementation(async () => {});
  mocks.heartbeat.mockResolvedValue(mocks.stopHeartbeat);
});

afterEach(() => {
  for (const [call] of mocks.start.mock.calls) rmSync(join((call as DriverRequest).stateDir, '..'), { recursive: true, force: true });
});

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
  return {
    platform: 'android',
    runId: 'run-1',
    targetName: 'android',
    slot: 0,
    slots: 2,
    agentDeviceVersion: '0.21.36',
    projectRoot: '/project',
    env,
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

const context: DeviceReleaseContext = { runId: 'run-1', targetName: 'android', env, signal: new AbortController().signal, timeoutMs: 30_000, log: () => undefined };

const driver = (call = 0) => mocks.start.mock.calls[call]![0] as DriverRequest;
const driverEnv = (call = 0) => mocks.start.mock.calls[call]![1] as NodeJS.ProcessEnv;
const leases = () => agentDeviceLeases({ provider: 'cloud', label: 'Cloud' });

function hangUntilAborted(onCalled: () => void) {
  return (_stateDir: string, _scope: LeaseScopedOptions, signal: AbortSignal) =>
    new Promise<boolean>((_resolve, reject) => {
      onCalled();
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

describe('agentDeviceLeases()', () => {
  it('allocates a retained lease from its own daemon, with the selectors and the platform backend', async () => {
    const lease = await leases().acquire(request(), allocation);
    expect(driver().allocate).toEqual({
      tenant: 'cloud',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'cloud',
      platform: 'android',
      target: 'mobile',
      device: 'Google Pixel 9',
      providerOsVersion: '16.0',
      providerApp: 'cloud://APP0',
      ttlMs: 60_000,
      retainOnClose: true,
    });
    expect(mocks.start).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'Cloud');
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(true);
    await leases().acquire(request({ platform: 'ios' }), allocation);
    expect(driver(1).allocate).toMatchObject({ leaseBackend: 'ios-instance', platform: 'ios' });
    expect(lease.id).toBe('lease-1');
  });

  it('hands the worker the lease scope and the selectors but `device` as JSON client configuration, without credentials', async () => {
    const req = request();
    const lease = await leases().acquire(req, allocation);
    expect(lease).toEqual({
      id: 'lease-1',
      client: {
        stateDir: driver().stateDir,
        tenant: 'cloud',
        runId: 'run-1',
        leaseId: 'lease-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'cloud',
        platform: 'android',
        target: 'mobile',
        providerOsVersion: '16.0',
        providerApp: 'cloud://APP0',
      },
    });
    const json = JSON.stringify(lease);
    expect(JSON.parse(json)).toEqual(lease);
    expect(json).not.toContain('cloud-key');
    expect(mocks.heartbeat).toHaveBeenCalledWith(driver().stateDir, { tenant: 'cloud', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'cloud' }, req.log);
  });

  it('logs the granted lease with its summary', async () => {
    const lines: string[] = [];
    await leases().acquire(request({ log: (line) => lines.push(line) }), allocation);
    expect(lines).toEqual(['lease lease-1: Google Pixel 9, android 16.0']);
  });

  it('releases a granted lease when the run\'s log throws, instead of losing it', async () => {
    await expect(leases().acquire(request({ log: () => { throw new Error('log closed'); } }), allocation)).rejects.toThrow('log closed');
    expect(mocks.releaseLease).toHaveBeenCalledWith(driver().stateDir, { tenant: 'cloud', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'cloud' }, expect.any(AbortSignal));
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', expect.any(AbortSignal), { sessionEnded: true });
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('gives stopDriver an un-aborted signal during acquire cleanup when releaseLease hangs until its RPC timeout', async () => {
    vi.useFakeTimers();
    try {
      const releaseCalled = new Promise<void>((resolve) => {
        mocks.releaseLease.mockImplementationOnce(hangUntilAborted(resolve));
      });
      const pending = expect(
        leases().acquire(request({ log: () => { throw new Error('log closed'); } }), allocation),
      ).rejects.toThrow('log closed');
      await releaseCalled;
      await vi.advanceTimersByTimeAsync(11_999);
      expect(mocks.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      const stopSignal = mocks.stop.mock.calls[0]?.[4];
      expect(stopSignal).toBeInstanceOf(AbortSignal);
      expect(stopSignal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives each lease's daemon its own state, agent-device home, and the service's env, and never mutates process.env", async () => {
    const before = { ...process.env };
    const provider = leases();
    const runEnv = { ...env, CLOUD_USERNAME: 'run-user', AGENT_DEVICE_STATE_DIR: '/foreign', AGENT_DEVICE_HOME: '/foreign-home', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' };
    await Promise.all([provider.acquire(request({ env: runEnv }), allocation), provider.acquire(request({ slot: 1, env: runEnv }), allocation)]);
    expect(driver(0).stateDir).not.toBe(driver(1).stateDir);
    expect(driverEnv(0).AGENT_DEVICE_HOME).not.toBe(driverEnv(1).AGENT_DEVICE_HOME);
    expect(driverEnv(0)).toMatchObject({ CLOUD_USERNAME: 'ada', CLOUD_ACCESS_KEY: 'cloud-key', PATH: '/bin', AGENT_DEVICE_DAEMON_POLICY: '/policy.json' });
    expect(driverEnv(0).AGENT_DEVICE_STATE_DIR).toBeUndefined();
    expect(driverEnv(0).AGENT_DEVICE_HOME).toBe(join(driver(0).stateDir, '..', 'home'));
    expect(process.env).toEqual(before);
  });

  it("drops agent-device daemon settings from the service's env too, so it can't pick another daemon or home", async () => {
    await leases().acquire(request(), { ...allocation, env: { ...allocation.env, AGENT_DEVICE_HOME: '/foreign-home', AGENT_DEVICE_DAEMON_BASE_URL: 'http://foreign' } });
    expect(driverEnv().AGENT_DEVICE_HOME).toBe(join(driver().stateDir, '..', 'home'));
    expect(driverEnv().AGENT_DEVICE_DAEMON_BASE_URL).toBeUndefined();
    expect(driverEnv()).toMatchObject({ CLOUD_USERNAME: 'ada' });
  });

  it("prepares the daemon's home before it starts", async () => {
    const prepareHome = vi.fn(async (home: string) => {
      await writeFile(join(home, '..', 'prepared'), home);
    });
    await leases().acquire(request(), { ...allocation, prepareHome });
    expect(prepareHome).toHaveBeenCalledWith(driverEnv().AGENT_DEVICE_HOME);
    expect(readFileSync(join(driver().stateDir, '..', 'prepared'), 'utf8')).toBe(driverEnv().AGENT_DEVICE_HOME);
    expect(prepareHome.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
  });

  it('allocates nothing once the run is interrupted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(leases().acquire(request({ signal: controller.signal }), allocation)).rejects.toThrow();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('stops the daemon of a lease granted after an interrupt instead of handing it over', async () => {
    const controller = new AbortController();
    mocks.start.mockImplementationOnce(async () => {
      controller.abort();
      return { leaseId: 'lease-1', tenantId: 'cloud', runId: 'run-1', retainOnClose: true };
    });
    await expect(leases().acquire(request({ signal: controller.signal }), allocation)).rejects.toThrow('cancelled');
    expect(mocks.releaseLease).toHaveBeenCalledWith(driver().stateDir, { tenant: 'cloud', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'cloud' }, expect.any(AbortSignal));
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', expect.any(AbortSignal), { sessionEnded: true });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('stops the daemon when agent-device does not acknowledge retainOnClose', async () => {
    mocks.start.mockResolvedValueOnce({ leaseId: 'lease-1', tenantId: 'cloud', runId: 'run-1', retainOnClose: false });
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('agent-device did not acknowledge retainOnClose. Closing the engine session could end the Cloud lease before run-end release');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the daemon after a failed allocation or home setup, and reports a failed cleanup with the cause', async () => {
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('no capacity');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    // Nothing was granted, so a stop that finds no daemon has nothing to confirm.
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), undefined, 'Cloud', expect.any(AbortSignal), { sessionEnded: false });
    expect(mocks.heartbeat).not.toHaveBeenCalled();
    mocks.start.mockRejectedValueOnce(new Error('no capacity'));
    mocks.stop.mockRejectedValueOnce(new Error('daemon did not stop'));
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('Cloud lease failed: no capacity; cleanup also failed: daemon did not stop');
    await expect(leases().acquire(request(), { ...allocation, prepareHome: async () => { throw new Error('plugin missing'); } })).rejects.toThrow('plugin missing');
    expect(mocks.start).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenCalledTimes(3);
  });

  it('stops the heartbeat and the daemon and removes its directory once, however often it is asked', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    await Promise.all([provider.release(lease, context), provider.release(lease, context)]);
    await provider.release(lease, context);
    expect(mocks.stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLease).toHaveBeenCalledWith(driver().stateDir, { tenant: 'cloud', runId: 'run-1', leaseId: 'lease-1', leaseBackend: 'android-instance', leaseProvider: 'cloud' }, expect.any(AbortSignal));
    expect(mocks.releaseLease.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0]!);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', context.signal, { sessionEnded: true });
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('caps the RPC release budget so a hung releaseLease still leaves stopDriver an un-aborted signal, while honoring outer aborts', async () => {
    vi.useFakeTimers();
    try {
      const provider = leases();
      const lease = await provider.acquire(request(), allocation);
      const outer = new AbortController();
      let stopSignalAtStop: AbortSignal | undefined;
      const releaseCalled = new Promise<void>((resolve) => {
        mocks.releaseLease.mockImplementationOnce(hangUntilAborted(resolve));
      });
      mocks.stop.mockImplementationOnce(async (_stateDir, _env, _id, _label, signal) => {
        stopSignalAtStop = signal;
      });

      const pending = provider.release(lease, { ...context, signal: outer.signal });
      await releaseCalled;
      await vi.advanceTimersByTimeAsync(11_999);
      expect(mocks.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
      expect(mocks.stop).toHaveBeenCalledTimes(1);
      expect(stopSignalAtStop).toBe(outer.signal);
      expect(stopSignalAtStop?.aborted).toBe(false);

      const second = await provider.acquire(request({ slot: 1 }), allocation);
      const expiredOuter = new AbortController();
      let stopSignalWhenExpired: AbortSignal | undefined;
      const secondReleaseCalled = new Promise<void>((resolve) => {
        mocks.releaseLease.mockImplementationOnce(hangUntilAborted(resolve));
      });
      mocks.stop.mockImplementationOnce(async (_stateDir, _env, _id, _label, signal) => {
        stopSignalWhenExpired = signal;
      });

      const pendingExpired = provider.release(second, { ...context, signal: expiredOuter.signal });
      await secondReleaseCalled;
      expiredOuter.abort(new Error('cleanup budget exhausted'));
      await pendingExpired;

      expect(stopSignalWhenExpired).toBe(expiredOuter.signal);
      expect(stopSignalWhenExpired?.aborted).toBe(true);

      const shortLease = await provider.acquire(request({ slot: 2 }), allocation);
      const budget20s = new AbortController();
      const budget20sTimer = setTimeout(() => budget20s.abort(new Error('20s cleanup budget exhausted')), 20_000);
      let stopSignalOn20sBudget: AbortSignal | undefined;
      const shortReleaseCalled = new Promise<void>((resolve) => {
        mocks.releaseLease.mockImplementationOnce(hangUntilAborted(resolve));
      });
      mocks.stop.mockImplementationOnce(async (_stateDir, _env, _id, _label, signal) => {
        stopSignalOn20sBudget = signal;
      });

      const pending20s = provider.release(shortLease, { ...context, signal: budget20s.signal, timeoutMs: 20_000 });
      await shortReleaseCalled;
      // 20_000 ms minus the 15_000 ms stop reserve gives the RPC 5_000 ms.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mocks.stop).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.stop).toHaveBeenCalledTimes(3);
      await pending20s;
      clearTimeout(budget20sTimer);

      expect(stopSignalOn20sBudget).toBe(budget20s.signal);
      expect(stopSignalOn20sBudget?.aborted).toBe(false);

      // When rpcTimeout hits its 12 s cap and agent-device rejects with generic `request canceled`, report the timeout duration instead.
      const cappedLease = await provider.acquire(request({ slot: 9 }), allocation);
      mocks.releaseLease.mockImplementationOnce((_stateDir, _scope, signal) =>
        new Promise<boolean>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('request canceled')), { once: true });
        }));
      mocks.stop.mockRejectedValueOnce(new Error('graceful shutdown report unavailable'));
      const cappedPending = provider.release(cappedLease, context);
      const cappedAssertion = expect(cappedPending).rejects.toThrow(
        'Cloud lease release failed: Timed out after 12000 ms waiting for lease RPC release; graceful shutdown report unavailable',
      );
      await vi.advanceTimersByTimeAsync(12_000);
      await cappedAssertion;

      // Above 30 s, retain the 18 s stop reserve and grant the remaining budget (e.g. 42 s at 60 s) to the RPC.
      const largeBudgetLease = await provider.acquire(request({ slot: 10 }), allocation);
      const largeBudgetController = new AbortController();
      const largeBudgetCalled = new Promise<void>((resolve) => {
        mocks.releaseLease.mockImplementationOnce(hangUntilAborted(resolve));
      });
      const pending60s = provider.release(largeBudgetLease, { ...context, signal: largeBudgetController.signal, timeoutMs: 60_000 });
      await largeBudgetCalled;
      await vi.advanceTimersByTimeAsync(41_999);
      expect(mocks.stop).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.stop).toHaveBeenCalledTimes(5);
      await pending60s;

      // Budgets with less than MIN_RELEASE_RPC_MS above the 15_000 ms stop reserve (or omitted timeoutMs / NaN) skip the RPC.
      for (const [slot, budgetMs] of [[3, 19_999], [4, 16_000], [5, 10_000], [6, 5_000], [7, Number.NaN], [8, undefined]] as const) {
        const callsBefore = mocks.releaseLease.mock.calls.length;
        const stopsBefore = mocks.stop.mock.calls.length;
        const callIndex = mocks.start.mock.calls.length;
        const skippedLease = await provider.acquire(request({ slot }), allocation);
        const outerSignal = new AbortController().signal;
        await provider.release(skippedLease, { ...context, signal: outerSignal, timeoutMs: budgetMs });
        expect(mocks.releaseLease).toHaveBeenCalledTimes(callsBefore);
        expect(mocks.stop).toHaveBeenCalledTimes(stopsBefore + 1);
        expect(mocks.stop).toHaveBeenLastCalledWith(
          driver(callIndex).stateDir,
          driverEnv(callIndex),
          skippedLease.id,
          'Cloud',
          outerSignal,
          { sessionEnded: false },
        );
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a slow POSIX daemon stop (9 s / 10.5 s) enough budget under 10 s and 20 s cleanup timeouts', async () => {
    vi.useFakeTimers();
    try {
      const provider = leases();
      for (const [slot, budgetMs, stopDurationMs] of [[0, 10_000, 9_000], [1, 20_000, 10_500]] as const) {
        const leaseForSlowStop = await provider.acquire(request({ slot }), allocation);
        const budgetController = new AbortController();
        const budgetTimer = setTimeout(() => budgetController.abort(new Error('cleanup budget exhausted')), budgetMs);
        let daemonExited = false;
        if (budgetMs > 15_000) mocks.releaseLease.mockImplementationOnce(hangUntilAborted(() => {}));
        mocks.stop.mockImplementationOnce((_stateDir, _env, _id, _label, signal) =>
          new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            const timer = setTimeout(() => {
              daemonExited = true;
              resolve();
            }, stopDurationMs);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          }));
        const pendingSlowStop = provider.release(leaseForSlowStop, { ...context, signal: budgetController.signal, timeoutMs: budgetMs });
        await vi.advanceTimersByTimeAsync(budgetMs - 1);
        expect(daemonExited).toBe(true);
        await pendingSlowStop;
        clearTimeout(budgetTimer);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('tries a release again after one failed, without repeating an already confirmed RPC lease release', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    mocks.stop.mockRejectedValueOnce(new Error('daemon busy'));
    await expect(provider.release(lease, context)).rejects.toThrow('daemon busy');
    await provider.release(lease, context);
    expect(mocks.releaseLease).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(2);
    expect(mocks.stop).toHaveBeenLastCalledWith(driver().stateDir, driverEnv(), 'lease-1', 'Cloud', context.signal, { sessionEnded: true });
  });

  it('keeps failing to release a lease whose session end is unknown once its daemon is gone', async () => {
    const { assertSessionsEnded } = await vi.importActual<typeof import('../../src/lease/daemon.ts')>('../../src/lease/daemon.ts');
    const stopReport = (data: unknown) => JSON.stringify({ success: true, data });
    const forced = stopReport({ stopped: true, mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: [] });
    const notRunning = stopReport({ stopped: false, mode: 'not-running', providerReleases: { status: 'completed', released: [], pending: [] }, warnings: [] });
    mocks.releaseLease.mockResolvedValue(false);
    mocks.stop.mockImplementation(async (_stateDir, _env, leaseId, label) => assertSessionsEnded(mocks.stop.mock.calls.length === 1 ? forced : notRunning, leaseId, label));
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    const dir = driver().stateDir.replace(/state$/, '');
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device could not confirm its Cloud sessions ended');
    // The forced stop killed the daemon, so every later stop finds none: the release never resolves without evidence.
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device found no daemon running for lease lease-1, so nothing confirms its Cloud session ended');
    await expect(provider.release(lease, context)).rejects.toThrow('agent-device found no daemon running for lease lease-1');
    expect(mocks.stop).toHaveBeenCalledTimes(3);
    expect(existsSync(dir)).toBe(true);
  });

  it('falls back to daemon stop confirmation on non-warning RPC errors or false, and combines both errors when stop fails', async () => {
    const provider = leases();
    const first = await provider.acquire(request(), allocation);
    mocks.releaseLease.mockResolvedValueOnce(false);
    await provider.release(first, context);
    expect(mocks.stop).toHaveBeenLastCalledWith(driver(0).stateDir, driverEnv(0), 'lease-1', 'Cloud', context.signal, { sessionEnded: false });

    const second = await provider.acquire(request({ slot: 1 }), allocation);
    mocks.releaseLease.mockRejectedValueOnce(new Error('socket hang up'));
    await provider.release(second, context);
    expect(mocks.stop).toHaveBeenLastCalledWith(driver(1).stateDir, driverEnv(1), 'lease-2', 'Cloud', context.signal, { sessionEnded: false });

    const third = await provider.acquire(request({ slot: 2 }), allocation);
    mocks.releaseLease.mockRejectedValueOnce(new DOMException('Timed out waiting for lease RPC release', 'TimeoutError'));
    mocks.stop.mockRejectedValueOnce(new Error('graceful shutdown report unavailable'));
    await expect(provider.release(third, context)).rejects.toThrow('Cloud lease release failed: Timed out waiting for lease RPC release; graceful shutdown report unavailable');

    mocks.releaseLease.mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'No daemon is running.', { reason: 'daemon-not-running' }));
    mocks.stop.mockRejectedValueOnce(new Error('agent-device found no daemon running for lease lease-3'));
    let daemonNotRunningError: unknown;
    try {
      await provider.release(third, context);
    } catch (error) {
      daemonNotRunningError = error;
    }
    expect(daemonNotRunningError).toBeInstanceOf(Error);
    expect(daemonNotRunningError).not.toBeInstanceOf(AggregateError);
    expect((daemonNotRunningError as Error).message).toBe('agent-device found no daemon running for lease lease-3');
  });

  it('always fails on provider warning rejections even when daemon stop resolves, and aggregates with stop failures', async () => {
    const provider = leases();
    const first = await provider.acquire(request(), allocation);
    mocks.releaseLease.mockRejectedValueOnce(new ProviderReleaseWarningError('WEBDRIVER_SESSION_DELETE_FAILED: DELETE /session returned 500'));
    await expect(provider.release(first, context)).rejects.toThrow('WEBDRIVER_SESSION_DELETE_FAILED: DELETE /session returned 500');
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenLastCalledWith(driver(0).stateDir, driverEnv(0), 'lease-1', 'Cloud', context.signal, { sessionEnded: false });

    const second = await provider.acquire(request({ slot: 1 }), allocation);
    mocks.releaseLease.mockRejectedValueOnce(new ProviderReleaseWarningError('WEBDRIVER_SESSION_DELETE_FAILED: DELETE /session returned 500'));
    mocks.stop.mockRejectedValueOnce(new Error('graceful shutdown report unavailable'));
    await expect(provider.release(second, context)).rejects.toThrow(
      'Cloud lease release failed: WEBDRIVER_SESSION_DELETE_FAILED: DELETE /session returned 500; graceful shutdown report unavailable',
    );
  });

  it('cleans up without stopping again when the stop confirmed the session ended but the cleanup failed', async () => {
    const provider = leases();
    const lease = await provider.acquire(request(), allocation);
    mocks.rm.mockRejectedValueOnce(new Error('EBUSY: resource busy or locked'));
    await expect(provider.release(lease, context)).rejects.toThrow('EBUSY');
    await provider.release(lease, context);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledTimes(2);
    expect(existsSync(driver().stateDir.replace(/state$/, ''))).toBe(false);
  });

  it('ignores a lease it does not hold', async () => {
    await leases().release({ id: 'other', client: { stateDir: '/tmp/x' } }, context);
    expect(mocks.stop).not.toHaveBeenCalled();
  });
});
