/**
 * `@e2e-dev/mobile/lease`: what a device-cloud provider package builds on
 * when agent-device runs the cloud's sessions itself (`leaseProvider`). Each
 * lease comes from its own agent-device daemon, in a private state directory
 * and home with the service's credentials, which this package's agent-device
 * starts, renews, and stops.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentDeviceClient, isAgentDeviceError, type LeaseScopedOptions } from 'agent-device';
import { deviceSelection, type DeviceClientConfig } from '../bindings.ts';
import type { DeviceLease, DeviceReleaseContext, DeviceRequest } from '../provider.ts';
import { installedIdentity } from '../support.ts';
import { ProviderReleaseWarningError, releaseLease, startDriver, stopDriver } from './daemon.ts';
import { LEASE_TTL_MS, startHeartbeat } from './heartbeat.ts';

export { agentDevicePlugin, type AgentDevicePlugin } from './plugin.ts';

type ProviderSelector = Extract<keyof DeviceClientConfig, `provider${string}`>;

/** The device a lease asks the service for, and the `provider*` capabilities its session starts with. */
export type LeaseSelectors = { readonly device: string } & Readonly<Partial<Pick<DeviceClientConfig, ProviderSelector>>>;

/** One service agent-device leases devices from. */
export interface AgentDeviceLeaseOptions {
  /** agent-device's name for the service, as the lease provider and tenant: `'browserstack'`. */
  readonly provider: string;
  /** The service's name in errors: `'BrowserStack'`. */
  readonly label: string;
}

/** What one `acquire` allocates. */
export interface AgentDeviceLeaseRequest {
  /** Set on the daemon's environment over the run's: the service's credentials. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Allocated with the lease. All but `device` are also put on its `client`, so
   * the worker's session matches it; the lease scope already picks the one
   * device the daemon holds, which a plugin may list under its own name.
   */
  readonly selectors: LeaseSelectors;
  /** What the progress line names once the lease is granted, after `lease <id>: `. */
  readonly summary: string;
  /** Runs on the daemon's empty agent-device home before it starts, to install a plugin there. */
  readonly prepareHome?: ((home: string) => Promise<void>) | undefined;
  /**
   * Installs the request's `appPath`, when it has one, through the lease's own
   * daemon once the lease is granted, and reports the app as `installedApp`:
   * for a service whose devices start without the build and take it from the
   * daemon afterwards. Each lease uploads the build itself.
   */
  readonly installAppPath?: boolean | undefined;
}

/** `acquire` and `release` of a `DeviceProvider` backed by agent-device leases. */
export interface AgentDeviceLeases {
  acquire(request: DeviceRequest, lease: AgentDeviceLeaseRequest): Promise<DeviceLease>;
  /** Releases the lease via its daemon when running, stops the daemon, and throws unless agent-device confirms it ended the lease's session. */
  release(lease: DeviceLease, context: DeviceReleaseContext): Promise<void>;
}

const DEFAULT_RELEASE_BUDGET_MS = 30_000;
const RELEASE_RPC_TIMEOUT_MS = 12_000;
/** Skip the RPC when less than this remains, because a cancelled RPC can delete the daemon's lease record just before `daemon stop` inspects it. */
const MIN_RELEASE_RPC_MS = 5_000;
/** Reserve time `daemon stop` may need after a hung provider DELETE: graceful drain, then SIGTERM and SIGKILL. */
const STOP_RESERVE_MS = 15_000;

function releaseRpcBudgetMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return 0;
  // Above 30 s, keep the 18 s (DEFAULT_RELEASE_BUDGET_MS - RELEASE_RPC_TIMEOUT_MS) stop reserve and give the rest to slow provider DELETEs.
  const rpc = Math.max(
    Math.min(RELEASE_RPC_TIMEOUT_MS, timeoutMs - STOP_RESERVE_MS),
    timeoutMs - (DEFAULT_RELEASE_BUDGET_MS - RELEASE_RPC_TIMEOUT_MS),
  );
  return rpc >= MIN_RELEASE_RPC_MS ? rpc : 0;
}

type LeaseLifecycle =
  | { stage: 'acquiring' }
  | { stage: 'held' | 'session-ended'; readonly scope: LeaseScopedOptions }
  | { stage: 'stopped' };

/** One lease's daemon lifecycle: RPC release moves `'held'` to `'session-ended'`, stop moves it to `'stopped'`, so a retry skips finished steps. */
interface Held {
  readonly dir: string;
  readonly stateDir: string;
  readonly env: NodeJS.ProcessEnv;
  lifecycle: LeaseLifecycle;
  stopHeartbeat?: () => Promise<void>;
  releasing?: Promise<void> | undefined;
}

/**
 * Leases from `options.provider` for a `DeviceProvider`: one isolated
 * agent-device daemon per lease, allocated with `retainOnClose` so closing
 * the engine session keeps it, renewed while held, and ended via RPC on
 * release before stopping the daemon (falling back to daemon stop).
 */
export function agentDeviceLeases({ provider, label }: AgentDeviceLeaseOptions): AgentDeviceLeases {
  const held = new Map<string, Held>();

  /** One release per lease, shared by every caller; a failed one may be tried again. */
  function release(id: string | undefined, resource: Held, signal: AbortSignal, timeoutMs: number | undefined): Promise<void> {
    resource.releasing ??= (async () => {
      await resource.stopHeartbeat?.();
      if (resource.lifecycle.stage !== 'stopped') {
        await endLeaseDaemon(id, resource, label, signal, timeoutMs);
        resource.lifecycle = { stage: 'stopped' };
      }
      await rm(resource.dir, { recursive: true, force: true });
      if (id !== undefined) held.delete(id);
    })();
    resource.releasing.catch(() => { resource.releasing = undefined; });
    return resource.releasing;
  }

  return {
    async acquire(request, { env, selectors, summary, prepareHome, installAppPath }) {
      request.signal.throwIfAborted();
      const dir = await mkdtemp(join(tmpdir(), `e2e-${provider}-`));
      const home = join(dir, 'home');
      const resource: Held = { dir, stateDir: join(dir, 'state'), env: daemonEnv({ ...request.env, ...env }, home), lifecycle: { stage: 'acquiring' } };
      const leaseBackend: 'ios-instance' | 'android-instance' = request.platform === 'ios' ? 'ios-instance' : 'android-instance';
      const allocated = { platform: request.platform, target: 'mobile' as const, ...selectors };
      let id: string | undefined;
      try {
        await prepareHome?.(home);
        const grant = await startDriver({
          stateDir: resource.stateDir,
          allocate: {
            tenant: provider,
            runId: request.runId,
            leaseBackend,
            leaseProvider: provider,
            ttlMs: LEASE_TTL_MS,
            // Retain the provider lease when closeApp or cleanup closes the engine session.
            // The provider releases the lease at run end.
            retainOnClose: true,
            ...allocated,
          },
        }, resource.env, label);
        id = grant.leaseId;
        const scope = { tenant: grant.tenantId, runId: grant.runId, leaseId: grant.leaseId, leaseBackend, leaseProvider: provider };
        resource.lifecycle = { stage: 'held', scope };
        held.set(id, resource);
        if (request.signal.aborted) throw new Error('cancelled');
        if (!grant.retainOnClose) throw new Error(`agent-device did not acknowledge retainOnClose. Closing the engine session could end the ${label} lease before run-end release`);
        resource.stopHeartbeat = await startHeartbeat(resource.stateDir, scope, request.log);
        request.log(`lease ${id}: ${summary}`);
        // The worker's client is created with these fields: the scope picks the lease, and the selectors match the session it holds.
        const { device: _device, ...clientSelectors } = allocated;
        const lease: DeviceLease = { id, client: { stateDir: resource.stateDir, ...scope, ...clientSelectors } };
        return installAppPath === true ? await installLeasedApp(request, lease) : lease;
      } catch (cause) {
        // The engine releases only leases `acquire` returned.
        try {
          await release(id, resource, AbortSignal.timeout(DEFAULT_RELEASE_BUDGET_MS), DEFAULT_RELEASE_BUDGET_MS);
        } catch (cleanup) {
          throw new AggregateError([cause, cleanup], `${label} lease failed: ${messageOf(cause)}; cleanup also failed: ${messageOf(cleanup)}`, { cause: cleanup });
        }
        throw cause;
      }
    },
    async release(lease, context) {
      const resource = held.get(lease.id);
      if (resource) await release(lease.id, resource, context.signal, context.timeoutMs);
    },
  };
}

/**
 * Installs the request's `appPath` on a leased device through the lease's own
 * daemon, and resolves to the lease with the app as `installedApp`; without an
 * `appPath`, to the lease as it is. For a service whose devices start without
 * the build: each lease uploads it. The install runs in a session of its own,
 * closed before the worker opens its session on the device. A lease whose
 * install throws is still the caller's to release.
 */
export async function installLeasedApp(request: DeviceRequest, lease: DeviceLease): Promise<DeviceLease> {
  const { appPath } = request;
  if (appPath === undefined) return lease;
  const { daemon } = lease;
  const installer = createAgentDeviceClient({
    ...lease.client,
    session: `e2e-install-${lease.id}`,
    // Without a daemon address, an explicit empty URL selects the lease's stateDir instead of an ambient remote daemon.
    ...(daemon === undefined
      ? { daemonBaseUrl: '', daemonAuthToken: '', daemonTransport: 'auto' as const }
      : { daemonBaseUrl: daemon.baseUrl, ...(daemon.authToken === undefined ? {} : { daemonAuthToken: daemon.authToken }) }),
  });
  try {
    const installed = await installer.apps.install({
      ...deviceSelection(request.platform, lease),
      appPath,
      signal: request.signal,
      ...(request.app === undefined ? {} : { app: request.app }),
    });
    return { ...lease, installedApp: installedIdentity(installed, request.app, appPath, "the target's `app.bundleId`").app };
  } finally {
    await installer.sessions.close({ signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }
}

/** `env` for a daemon in `home`: no daemon setting in it may select a different daemon, home, or connection profile. */
function daemonEnv(env: DeviceRequest['env'], home: string): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    // Keep the user's security policy on both the daemon and its clients.
    if (key === 'AGENT_DEVICE_DAEMON_POLICY') continue;
    if (key.startsWith('AGENT_DEVICE_')) delete result[key];
  }
  result.AGENT_DEVICE_HOME = home;
  return result;
}

async function endLeaseDaemon(
  id: string | undefined,
  resource: Held,
  label: string,
  signal: AbortSignal,
  timeoutMs: number | undefined,
): Promise<void> {
  let releaseError: unknown;
  const { lifecycle } = resource;
  const rpcBudgetMs = releaseRpcBudgetMs(timeoutMs);
  if (lifecycle.stage === 'held' && rpcBudgetMs > 0) {
    // Reserve STOP_RESERVE_MS for `stopDriver` so a hung provider DELETE never exhausts `signal` before `daemon stop` spawns and exits.
    const rpcTimeout = new AbortController();
    const timer = setTimeout(
      () => rpcTimeout.abort(new DOMException('Timed out waiting for lease RPC release', 'TimeoutError')),
      rpcBudgetMs,
    );
    timer.unref?.();
    const rpcSignal = AbortSignal.any([signal, rpcTimeout.signal]);
    try {
      if (await releaseLease(resource.stateDir, lifecycle.scope, rpcSignal)) {
        lifecycle.stage = 'session-ended';
      }
    } catch (error) {
      releaseError = rpcTimeout.signal.aborted
        ? new Error(`Timed out after ${rpcBudgetMs} ms waiting for lease RPC release`, { cause: error })
        : error;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await stopDriver(resource.stateDir, resource.env, id, label, signal, {
      sessionEnded: lifecycle.stage === 'session-ended',
    });
  } catch (stopError) {
    // When the daemon died mid-run, `stopDriver` already reports the missing daemon for the lease.
    const daemonNotRunning =
      isAgentDeviceError(releaseError) && releaseError.details?.reason === 'daemon-not-running';
    if (releaseError !== undefined && !daemonNotRunning) {
      throw new AggregateError(
        [releaseError, stopError],
        `${label} lease release failed: ${messageOf(releaseError)}; ${messageOf(stopError)}`,
        { cause: stopError },
      );
    }
    throw stopError;
  }
  // Warnings from `leases.release` mean agent-device already ran provider teardown and the service rejected it; daemon stop cannot retry it.
  if (releaseError instanceof ProviderReleaseWarningError) throw releaseError;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
