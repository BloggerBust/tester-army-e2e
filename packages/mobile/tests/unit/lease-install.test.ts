/**
 * `agentDeviceLeases()` with `installAppPath`: the build goes through the
 * lease's own daemon, never an ambient one, and a failed install releases the
 * lease it was granted for. `installLeasedApp()` on a lease that names a
 * daemon address installs through that daemon, on the device the lease names.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceRequest } from '../../src/index.ts';
import { agentDeviceLeases, installLeasedApp, type AgentDeviceLeaseRequest } from '../../src/lease/index.ts';
import type { DriverRequest } from '../../src/lease/driver.ts';

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(async () => {}),
  stopHeartbeat: vi.fn(async () => {}),
  client: vi.fn(),
  install: vi.fn(async (): Promise<Record<string, string>> => ({ package: 'com.example.local' })),
  close: vi.fn(async () => {}),
}));
vi.mock('../../src/lease/daemon.ts', async (original) => ({ ...(await original<typeof import('../../src/lease/daemon.ts')>()), startDriver: mocks.start, stopDriver: mocks.stop }));
vi.mock('../../src/lease/heartbeat.ts', () => ({ LEASE_TTL_MS: 60_000, startHeartbeat: async () => mocks.stopHeartbeat }));
vi.mock('agent-device', () => ({
  createAgentDeviceClient: (config: unknown) => {
    mocks.client(config);
    return { apps: { install: mocks.install }, sessions: { close: mocks.close } };
  },
}));

const allocation: AgentDeviceLeaseRequest = {
  env: { CLOUD_ACCESS_KEY: 'cloud-key' },
  selectors: { device: 'Pixel 7' },
  summary: 'Pixel 7, android',
  installAppPath: true,
};
const APP_PATH = '/project/build/app.apk';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.start.mockImplementation(async ({ allocate }: DriverRequest) => ({ leaseId: 'lease-1', tenantId: allocate.tenant, runId: allocate.runId, retainOnClose: true }));
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
    slots: 1,
    app: 'com.example.app',
    appPath: APP_PATH,
    agentDeviceVersion: '0.21.40',
    projectRoot: '/project',
    env: { PATH: '/bin', AGENT_DEVICE_DAEMON_BASE_URL: 'https://remote.example' },
    signal: new AbortController().signal,
    log: () => undefined,
    ...overrides,
  };
}

const leases = () => agentDeviceLeases({ provider: 'cloud', label: 'Cloud' });

describe('agentDeviceLeases() installAppPath', () => {
  it("installs app.appPath through the lease's own daemon and reports the installed app", async () => {
    const lease = await leases().acquire(request(), allocation);
    const stateDir = (mocks.start.mock.calls[0]![0] as DriverRequest).stateDir;
    expect(mocks.client).toHaveBeenCalledWith({
      stateDir,
      tenant: 'cloud',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'cloud',
      platform: 'android',
      target: 'mobile',
      session: 'e2e-install-lease-1',
      daemonBaseUrl: '',
      daemonAuthToken: '',
      daemonTransport: 'auto',
    });
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ appPath: APP_PATH, platform: 'android', app: 'com.example.app' }));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(lease.installedApp).toBe('com.example.local');
  });

  it.each([
    ['without installAppPath', request(), { ...allocation, installAppPath: undefined }],
    ['without an appPath', request({ appPath: undefined }), allocation],
  ])('installs nothing %s', async (_case, req, alloc) => {
    const lease = await leases().acquire(req, alloc);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(lease.installedApp).toBeUndefined();
  });

  it('releases the lease when the install fails, and reports the install failure', async () => {
    mocks.install.mockRejectedValueOnce(new Error('the service refused the build'));
    await expect(leases().acquire(request(), allocation)).rejects.toThrow('the service refused the build');
    expect(mocks.stopHeartbeat).toHaveBeenCalledOnce();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('fails the acquire with ENGINE_FAILURE, and releases the lease, when the install names no app', async () => {
    mocks.install.mockResolvedValueOnce({});
    await expect(leases().acquire(request({ app: undefined }), allocation)).rejects.toMatchObject({
      code: 'ENGINE_FAILURE',
      message: expect.stringContaining('reported no bundle id or package'),
    });
    expect(mocks.stop).toHaveBeenCalledOnce();
  });
});

describe('installLeasedApp()', () => {
  const lease = { id: 's1', daemon: { baseUrl: 'https://s1.example', authToken: 'daemon-token' }, deviceId: 'emulator-5554' };

  it("installs app.appPath through the daemon the lease names, on the lease's device", async () => {
    await expect(installLeasedApp(request(), lease)).resolves.toEqual({ ...lease, installedApp: 'com.example.local' });
    expect(mocks.client).toHaveBeenCalledWith({ session: 'e2e-install-s1', daemonBaseUrl: 'https://s1.example', daemonAuthToken: 'daemon-token' });
    expect(mocks.install).toHaveBeenCalledWith(expect.objectContaining({ appPath: APP_PATH, platform: 'android', serial: 'emulator-5554', app: 'com.example.app' }));
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('returns the lease as it is for a request without an appPath', async () => {
    await expect(installLeasedApp(request({ appPath: undefined }), lease)).resolves.toBe(lease);
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('closes the install session and rejects with the install failure', async () => {
    mocks.install.mockRejectedValueOnce(new Error('upload refused'));
    await expect(installLeasedApp(request(), lease)).rejects.toThrow('upload refused');
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
