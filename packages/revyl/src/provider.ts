/**
 * Revyl's hosted iOS simulators and Android emulators as a `DeviceProvider`
 * for the mobile engine, through agent-device's `@agent-device/revyl` plugin:
 * each lease comes from its own agent-device daemon, which starts a Revyl
 * device with the app installed from an `https` URL, or with no app and
 * then the target's local `app.appPath` installed on it.
 */

import type { DeviceLease, DeviceProvider, DeviceRequest } from '@e2e-dev/mobile';
import { agentDeviceLeases, agentDevicePlugin, type LeaseSelectors } from '@e2e-dev/mobile/lease';
import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';
import { credentialsEnv, revylCredentials } from './credentials.ts';

/** agent-device's name for Revyl, as the lease provider and the tenant. */
const PROVIDER = 'revyl';

const plugin = agentDevicePlugin(import.meta.resolve('@agent-device/revyl'));

/** Every option `revyl()` takes, kept equal to `RevylOptions` by the compiler. */
const OPTION_KEYS: readonly string[] = Object.keys({
  app: true,
  device: true,
  osVersion: true,
} satisfies Record<keyof RevylOptions, true>);

/** What `revyl()` takes: the build Revyl installs, and the device model it runs on. */
export interface RevylOptions {
  /**
   * `https` URL Revyl downloads the build from when it starts each device: an
   * iOS simulator build (`.app` zipped) or an Android `.apk`. A local path is
   * refused, since Revyl cannot read it; name a local build with the target's
   * `app.appPath` instead. Absent, the device starts with no app, and the
   * target's `app.appPath`, when it has one, is installed on it.
   */
  readonly app?: string | undefined;
  /** Device model as Revyl lists it: `iPhone 17 Pro Max`, `Pixel 7`. */
  readonly device: string;
  /** OS version as Revyl lists it for that model: `iOS 27.0`, `Android 14`. Absent, Revyl's default for the model. */
  readonly osVersion?: string | undefined;
}

/**
 * Revyl devices for `mobile({ device: revyl({ app, device }) })`: one hosted
 * device and isolated agent-device daemon per worker slot. Allocating the
 * lease starts the Revyl device, which installs `app`; releasing it ends the
 * device session via the daemon before stopping it (falling back to daemon
 * stop if the RPC does not confirm release).
 */
export function revyl(options: RevylOptions): DeviceProvider {
  rejectUnknownKeys('revyl()', options, OPTION_KEYS);
  const device: unknown = options.device;
  if (typeof device !== 'string' || device.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `device` is required, as a non-empty string');
  }
  const osVersion: unknown = options.osVersion;
  if (osVersion !== undefined && (typeof osVersion !== 'string' || osVersion.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `osVersion` must be a non-empty string');
  }
  const app: unknown = options.app;
  if (app !== undefined && (typeof app !== 'string' || !isHttpsUrl(app))) {
    // The value is left out: a rejected URL can carry credentials or a presigned signature.
    throw new ConfigurationError('INVALID_CONFIG', 'revyl: `app` must be an https URL, without credentials, that Revyl can download the build from');
  }
  const leases = agentDeviceLeases({ provider: PROVIDER, label: 'Revyl' });

  return {
    name: PROVIDER,
    async acquire(request: DeviceRequest): Promise<DeviceLease> {
      plugin.assertVersion(request.agentDeviceVersion);
      if (request.appPath !== undefined && app !== undefined) {
        throw new Error("Revyl installs the app from `app`; leave the target's `app.appPath` out, or leave `app` out to install that build instead");
      }
      const credentials = revylCredentials(request.env);
      const selectors = {
        device,
        ...(app === undefined ? {} : { providerApp: app }),
        ...(options.osVersion === undefined ? {} : { providerOsVersion: options.osVersion }),
      } satisfies LeaseSelectors;
      return leases.acquire(request, {
        env: credentialsEnv(credentials),
        selectors,
        summary: `${device}, ${options.osVersion ?? request.platform}; Revyl device started`,
        prepareHome: plugin.prepareHome,
        installAppPath: true,
      });
    },
    release: (lease, context) => leases.release(lease, context),
  };
}

/** An `https` URL without credentials in it, the only app source the Revyl plugin accepts. */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}
