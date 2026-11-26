import { execFile, fork } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentDeviceClient, type CloudProviderSessionResult, type LeaseScopedOptions } from 'agent-device';
import type { DriverGrant, DriverRequest } from './driver.ts';
import { field, installedPackage } from './package.ts';
import { leaseSession } from './session.ts';

const exec = promisify(execFile);

/** The installed agent-device CLI entry, resolved from its package without importing it. */
function agentDeviceBin(): string {
  const { directory, manifest } = installedPackage(import.meta.resolve('agent-device'));
  const bin = field(field(manifest, 'bin'), 'agent-device');
  if (typeof bin !== 'string') throw new Error('The installed agent-device package has no agent-device bin');
  return path.join(directory, bin);
}

/**
 * Allocates a lease from a fresh daemon in a separate process, so each daemon
 * gets its own credentials and home without changing the runner's environment.
 * Not cancellable: an interrupted allocation can still grant a lease, which
 * the caller then releases.
 */
export async function startDriver(request: DriverRequest, env: NodeJS.ProcessEnv, label: string): Promise<DriverGrant> {
  const entry = new URL(import.meta.url.endsWith('.ts') ? './driver.ts' : './driver.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let answered = false;
    child.once('error', reject);
    child.once('message', (reply: { grant?: DriverGrant; error?: string }) => {
      answered = true;
      if (reply.grant) resolve(reply.grant);
      else reject(new Error(reply.error ?? `${label} driver returned no lease`));
    });
    child.once('exit', () => {
      if (!answered) reject(new Error(`${label} driver exited before allocation finished`));
    });
    child.send(request);
  });
}

/** Options for {@link stopDriver} and {@link assertSessionsEnded}. */
export interface StopDriverOptions {
  /** True when `leases.release` already confirmed the daemon ended the lease's session. */
  readonly sessionEnded?: boolean;
}

/** Error thrown when `leases.release` ran provider teardown and the cloud service rejected or warned on it. */
export class ProviderReleaseWarningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderReleaseWarningError';
  }
}

/**
 * Releases `scope` on an already running daemon without starting or replacing
 * one, and returns whether the daemon confirmed it removed the lease record
 * without provider cleanup warnings.
 */
export async function releaseLease(stateDir: string, scope: LeaseScopedOptions, signal: AbortSignal): Promise<boolean> {
  // Attach-only with empty remote fields reaches only this lease's daemon and never spawns a replacement.
  const client = createAgentDeviceClient({
    stateDir,
    session: leaseSession(stateDir),
    daemonBaseUrl: '',
    daemonAuthToken: '',
    daemonTransport: 'auto',
    daemonLifecycle: 'attach',
  });
  const { released, provider } = await client.leases.release({ ...scope, signal });
  const warnings = releaseWarnings(provider);
  if (warnings.length > 0) throw new ProviderReleaseWarningError(warnings.join('; '));
  return released;
}

function releaseWarnings(provider: CloudProviderSessionResult | undefined): string[] {
  const raw = field(provider, 'warnings');
  if (!Array.isArray(raw)) return [];
  const messages: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) {
      messages.push(entry);
      continue;
    }
    const message = field(entry, 'message');
    if (typeof message !== 'string' || message.length === 0) continue;
    const code = field(entry, 'code');
    messages.push(typeof code === 'string' && code.length > 0 ? `${code}: ${message}` : message);
  }
  return messages;
}

/**
 * Stops the daemon, which releases its leases and so ends their sessions at
 * the service, and throws unless it confirms they ended. `leaseId` is the
 * lease the daemon granted, when it granted one.
 */
export async function stopDriver(
  stateDir: string,
  env: NodeJS.ProcessEnv,
  leaseId: string | undefined,
  label: string,
  signal: AbortSignal,
  options?: StopDriverOptions,
): Promise<void> {
  const { stdout } = await exec(process.execPath, [agentDeviceBin(), 'daemon', 'stop', '--state-dir', stateDir, '--clean', '--json'], { env, signal });
  assertSessionsEnded(stdout, leaseId, label, options);
}

/**
 * Throws unless `daemon stop --json` reports every session ended.
 * A forced stop or a lost shutdown report comes back as `status: 'unknown'`
 * with `pending: null`: the session may still be running, and billed.
 *
 * A granted lease also needs the report to list it as released, unless
 * `options.sessionEnded` confirms an earlier `leases.release` call already
 * ended it. A daemon that is not running reports nothing pending
 * (`mode: 'not-running'`), and so does one started after the granting daemon
 * died, while the session may still be open. Without `leaseId`, before anything
 * was granted, such a report means there is nothing to release.
 */
export function assertSessionsEnded(
  stdout: string,
  leaseId: string | undefined,
  label: string,
  options?: StopDriverOptions,
): void {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`agent-device stopped without a readable shutdown report; ${label} sessions may still be running`);
  }
  const data = field(report, 'data');
  const releases = field(data, 'providerReleases');
  const pending = field(releases, 'pending');
  if (Array.isArray(pending) && pending.length > 0) throw new Error(`agent-device stopped without ending ${pending.length} ${label} session(s)`);
  const sessionEnded = options?.sessionEnded === true;
  const status = field(releases, 'status');
  const reportComplete = status === 'completed' && Array.isArray(pending);
  // If `leases.release` already ended the session, unpatched Windows `daemon stop` may still lack a shutdown report (`status: 'unknown'`).
  if (!reportComplete && !(sessionEnded && status === 'unknown')) {
    const warnings = field(data, 'warnings');
    const detail = Array.isArray(warnings) ? warnings.filter((warning): warning is string => typeof warning === 'string').join(' ') : '';
    throw new Error(`agent-device could not confirm its ${label} sessions ended${detail === '' ? '' : `: ${detail}`}`);
  }
  if (leaseId === undefined || sessionEnded) return;
  const released = field(releases, 'released');
  if (Array.isArray(released) && released.some((entry) => field(entry, 'leaseId') === leaseId)) return;
  const what = field(data, 'mode') === 'not-running' ? `found no daemon running for lease ${leaseId}` : `stopped without listing lease ${leaseId} as released`;
  throw new Error(`agent-device ${what}, so nothing confirms its ${label} session ended`);
}
