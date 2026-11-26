/** Against the installed agent-device: the daemon stop a lease's release relies on, and the report it checks. */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentDeviceClient, isAgentDeviceError } from 'agent-device';
import { afterAll, expect, it, vi } from 'vitest';
import { assertSessionsEnded, ProviderReleaseWarningError, releaseLease, stopDriver } from '../../src/lease/daemon.ts';
import { agentDeviceLeases } from '../../src/lease/index.ts';

vi.mock('agent-device', async (original) => {
  const actual = await original<typeof import('agent-device')>();
  return { ...actual, createAgentDeviceClient: vi.fn(actual.createAgentDeviceClient) };
});

const dir = mkdtempSync(path.join(tmpdir(), 'lease-daemon-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('stops a daemon that is not running without error before a lease was granted', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, undefined, 'BrowserStack', AbortSignal.timeout(30_000))).resolves.toBeUndefined();
});

it('refuses to confirm a granted lease ended when no daemon is running to release it', async () => {
  await expect(stopDriver(path.join(dir, 'state'), { PATH: process.env['PATH'], HOME: dir }, 'lease-1', 'BrowserStack', AbortSignal.timeout(30_000))).rejects.toThrow(
    'agent-device found no daemon running for lease lease-1, so nothing confirms its BrowserStack session ended',
  );
});

const report = (data: unknown) => JSON.stringify({ success: true, data });
const graceful = (released: unknown[], pending: unknown[] = []) => report({ stopped: true, mode: 'graceful', providerReleases: { status: 'completed', released, pending }, warnings: [] });
const notRunning = report({ stopped: false, mode: 'not-running', providerReleases: { status: 'completed', released: [], pending: [] }, warnings: [] });

it('accepts a graceful stop that released the lease, and any graceful stop before a grant', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l1', provider: 'browserstack' }]), 'l1', 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(graceful([]), undefined, 'BrowserStack')).not.toThrow();
});

it('accepts no running daemon only before a lease was granted', () => {
  expect(() => assertSessionsEnded(notRunning, undefined, 'BrowserStack')).not.toThrow();
  expect(() => assertSessionsEnded(notRunning, 'l1', 'BrowserStack')).toThrow('agent-device found no daemon running for lease l1, so nothing confirms its BrowserStack session ended');
});

it('refuses a graceful stop that did not release the granted lease, as from a daemon started after the granting one died', () => {
  expect(() => assertSessionsEnded(graceful([{ leaseId: 'l2', provider: 'browserstack' }]), 'l1', 'BrowserStack')).toThrow(
    'agent-device stopped without listing lease l1 as released, so nothing confirms its BrowserStack session ended',
  );
});

it('refuses a report with sessions still pending', () => {
  expect(() => assertSessionsEnded(graceful([], [{ leaseId: 'l1' }, { leaseId: 'l2' }]), undefined, 'BrowserStack')).toThrow('agent-device stopped without ending 2 BrowserStack session(s)');
});

it('refuses a forced stop whose cleanup is unknown, with the daemon\'s warning', () => {
  const forced = report({ stopped: true, mode: 'forced', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.'] });
  expect(() => assertSessionsEnded(forced, 'l1', 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended: The daemon was force-killed before provider lease state could be finalized. Provider allocations may remain active.');
});

it('refuses a report without provider releases, and one that is not JSON', () => {
  expect(() => assertSessionsEnded(report({ stopped: true }), undefined, 'BrowserStack')).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed', undefined, 'BrowserStack')).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});

it('accepts an unconfirmed or missing-lease stop report when leases.release already ended the session, while still rejecting pending or unreadable reports', () => {
  const unknown = report({ stopped: true, mode: 'graceful', providerReleases: { status: 'unknown', released: [], pending: null }, warnings: ['The graceful shutdown report is unavailable.'] });
  expect(() => assertSessionsEnded(graceful([]), 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(notRunning, 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(unknown, 'l1', 'BrowserStack', { sessionEnded: true })).not.toThrow();
  expect(() => assertSessionsEnded(graceful([], [{ leaseId: 'l1' }]), 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device stopped without ending 1 BrowserStack session(s)');
  expect(() => assertSessionsEnded(report({ stopped: true }), 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device could not confirm its BrowserStack sessions ended');
  expect(() => assertSessionsEnded('killed', 'l1', 'BrowserStack', { sessionEnded: true })).toThrow('agent-device stopped without a readable shutdown report; BrowserStack sessions may still be running');
});

it('attaches to release a lease without spawning a daemon when none is running', async () => {
  const emptyState = path.join(dir, 'empty-state');
  let caught: unknown;
  try {
    await releaseLease(emptyState, { leaseId: 'lease-1', tenant: 'browserstack', runId: 'run-1', leaseBackend: 'ios-instance', leaseProvider: 'browserstack' }, AbortSignal.timeout(10_000));
  } catch (error) {
    caught = error;
  }
  expect(isAgentDeviceError(caught) && caught.details?.reason).toBe('daemon-not-running');
  expect(existsSync(path.join(emptyState, 'daemon.json'))).toBe(false);
});

it('rejects when leases.release reports provider cleanup warnings even if released is true', async () => {
  const mockedClient = vi.mocked(createAgentDeviceClient);
  const realClient = createAgentDeviceClient({ stateDir: path.join(dir, 'warn-state'), daemonLifecycle: 'attach' });
  mockedClient.mockReturnValueOnce({
    ...realClient,
    leases: {
      ...realClient.leases,
      release: async () => ({
        released: true,
        provider: {
          provider: 'browserstack',
          providerSessionId: 'wd-1',
          warnings: [{ code: 'WEBDRIVER_SESSION_DELETE_FAILED', message: 'HTTP 500 on DELETE /session/wd-1' }],
        },
      }),
    },
  });
  let warningError: unknown;
  try {
    await releaseLease(path.join(dir, 'warn-state'), { leaseId: 'lease-1', tenant: 'browserstack', runId: 'run-1', leaseBackend: 'ios-instance', leaseProvider: 'browserstack' }, AbortSignal.timeout(10_000));
  } catch (error) {
    warningError = error;
  }
  expect(warningError).toBeInstanceOf(ProviderReleaseWarningError);
  expect((warningError as Error).message).toBe('WEBDRIVER_SESSION_DELETE_FAILED: HTTP 500 on DELETE /session/wd-1');
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForDaemonExit(pid: number, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function withMockWebDriver(
  onDelete: (reply: (status: number, body: unknown) => void) => void,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    req.resume();
    if (req.method === 'POST' && req.url?.endsWith('/session')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ value: { sessionId: 'wd-short-1', capabilities: {} } }));
      return;
    }
    if (req.method === 'DELETE' && req.url?.includes('/session/')) {
      onDelete((status, body) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/wd/hub`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function withRealMockLease(
  runId: string,
  onDelete: (reply: (status: number, body: unknown) => void) => void,
  fn: (ctx: {
    leases: ReturnType<typeof agentDeviceLeases>;
    lease: Awaited<ReturnType<ReturnType<typeof agentDeviceLeases>['acquire']>>;
    env: NodeJS.ProcessEnv;
    pid: number;
  }) => Promise<void>,
): Promise<void> {
  let pid: number | undefined;
  let leaseDir: string | undefined;
  const leases = agentDeviceLeases({ provider: 'browserstack', label: 'BrowserStack' });
  try {
    await withMockWebDriver(onDelete, async (endpoint) => {
      const env = { ...process.env, BROWSERSTACK_USERNAME: 'u', BROWSERSTACK_ACCESS_KEY: 'k', BROWSERSTACK_WEBDRIVER_ENDPOINT: endpoint, BROWSERSTACK_SESSION_DETAILS_ENDPOINT: endpoint };
      const lease = await leases.acquire({
        platform: 'android',
        runId,
        targetName: 'android',
        slot: 0,
        slots: 1,
        agentDeviceVersion: '0.21.38',
        projectRoot: dir,
        env,
        signal: AbortSignal.timeout(20_000),
        log: () => undefined,
      }, {
        env: {},
        selectors: { device: 'Pixel 9', providerOsVersion: '15.0', providerApp: 'bs://app' },
        summary: 'Pixel 9, android 15.0',
      });
      const stateDir = lease.client!['stateDir'] as string;
      leaseDir = path.dirname(stateDir);
      pid = (JSON.parse(readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')) as { pid: number }).pid;
      expect(isPidAlive(pid)).toBe(true);
      await fn({ leases, lease, env, pid });
    });
  } finally {
    if (pid !== undefined && isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    if (leaseDir !== undefined) rmSync(leaseDir, { recursive: true, force: true });
  }
}

it('stops the real daemon process within a 5 s budget when DELETE takes 1.5 s (passing on POSIX, unconfirmed-stop on Windows)', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await withRealMockLease(
      'short-ok',
      (reply) => {
        const timer = setTimeout(() => reply(200, { value: null }), 1_500);
        timer.unref?.();
        timers.push(timer);
      },
      async ({ leases, lease, env, pid }) => {
        const releasePromise = leases.release(lease, { runId: 'short-ok', targetName: 'android', env, signal: AbortSignal.timeout(5_000), timeoutMs: 5_000, log: () => undefined });
        if (process.platform === 'win32') {
          // Budgets below STOP_RESERVE_MS + MIN_RELEASE_RPC_MS (20 s) skip the RPC and fall back to daemon stop, whose Win32 SIGTERM leaves no shutdown report in agent-device@0.21.38.
          await expect(releasePromise).rejects.toThrow('could not confirm its BrowserStack sessions ended');
        } else {
          await expect(releasePromise).resolves.toBeUndefined();
        }
        expect(await waitForDaemonExit(pid)).toBe(true);
      },
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

it('stops the real daemon process under a 16 s budget when DELETE takes 1.5 s instead of cancelling mid-flight', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await withRealMockLease(
      'short-16s-ok',
      (reply) => {
        const timer = setTimeout(() => reply(200, { value: null }), 1_500);
        timer.unref?.();
        timers.push(timer);
      },
      async ({ leases, lease, env, pid }) => {
        const releasePromise = leases.release(lease, { runId: 'short-16s-ok', targetName: 'android', env, signal: AbortSignal.timeout(16_000), timeoutMs: 16_000, log: () => undefined });
        if (process.platform === 'win32') {
          // Budgets below STOP_RESERVE_MS + MIN_RELEASE_RPC_MS (20 s) skip the RPC and fall back to daemon stop.
          await expect(releasePromise).rejects.toThrow('could not confirm its BrowserStack sessions ended');
        } else {
          await expect(releasePromise).resolves.toBeUndefined();
        }
        expect(await waitForDaemonExit(pid)).toBe(true);
      },
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
});

it('releases a slow 4 s DELETE 200 via RPC under a 30 s budget and stops the real daemon cleanly', async () => {
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await withRealMockLease(
      'rpc-30s-ok',
      (reply) => {
        const timer = setTimeout(() => reply(200, { value: null }), 4_000);
        timer.unref?.();
        timers.push(timer);
      },
      async ({ leases, lease, env, pid }) => {
        await expect(leases.release(lease, { runId: 'rpc-30s-ok', targetName: 'android', env, signal: AbortSignal.timeout(30_000), timeoutMs: 30_000, log: () => undefined })).resolves.toBeUndefined();
        expect(await waitForDaemonExit(pid)).toBe(true);
      },
    );
  } finally {
    for (const timer of timers) clearTimeout(timer);
  }
}, 40_000);

it('caps the RPC after 12 s and stops the real daemon process under a 30 s budget when DELETE /session hangs', async () => {
  await withRealMockLease(
    'hung-30s',
    () => {
      // Intentionally never respond so the 12 s RPC cap fires and daemon stop still has STOP_RESERVE_MS to shut down cleanly.
    },
    async ({ leases, lease, env, pid }) => {
      await expect(leases.release(lease, { runId: 'hung-30s', targetName: 'android', env, signal: AbortSignal.timeout(30_000), timeoutMs: 30_000, log: () => undefined })).rejects.toThrow('Timed out after 12000 ms waiting for lease RPC release');
      expect(await waitForDaemonExit(pid)).toBe(true);
    },
  );
}, 40_000);

it('fails release and stops the real daemon when DELETE /session returns HTTP 500', async () => {
  await withRealMockLease(
    'rpc-500',
    (reply) => reply(500, { value: { error: 'unknown error', message: 'provider failed' } }),
    async ({ leases, lease, env, pid }) => {
      await expect(leases.release(lease, { runId: 'rpc-500', targetName: 'android', env, signal: AbortSignal.timeout(30_000), timeoutMs: 30_000, log: () => undefined })).rejects.toThrow('WEBDRIVER_SESSION_DELETE_FAILED');
      expect(await waitForDaemonExit(pid)).toBe(true);
    },
  );
});
