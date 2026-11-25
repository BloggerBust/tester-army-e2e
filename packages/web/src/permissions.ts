/**
 * A web target's `app.permissions`: the browser permissions every page of an
 * attempt holds, or `'all'` for every one its browser grants. The surface
 * grants them on each context the attempt opens.
 */

import { ConfigurationError, rejectUnknownKeys, type AppPermissionState, type EngineAppInfo } from '@e2e-dev/core/engine';
import type { BrowserName } from './browser-connection.ts';

/** The permission names Playwright grants on each browser (playwright-core 1.65). */
const BROWSER_PERMISSIONS = {
  chromium: [
    'accelerometer', 'ambient-light-sensor', 'background-sync', 'camera', 'clipboard-read', 'clipboard-write',
    'geolocation', 'gyroscope', 'local-fonts', 'local-network-access', 'magnetometer', 'microphone', 'midi',
    'midi-sysex', 'notifications', 'payment-handler', 'screen-wake-lock', 'storage-access',
  ],
  firefox: ['geolocation', 'local-network-access', 'notifications', 'persistent-storage', 'push', 'screen-wake-lock'],
  webkit: ['camera', 'clipboard-read', 'geolocation', 'microphone', 'notifications', 'screen-wake-lock'],
} as const satisfies Record<BrowserName, readonly string[]>;

/**
 * Refuses a permission `browser` cannot grant, and any state but `grant`:
 * Playwright only grants, and Chromium denies every permission a grant
 * leaves out, so neither `deny` nor `reset` can mean what it does on a
 * device. The harness has checked the map's shape and states already.
 */
export function validatePermissions(targetName: string, browser: BrowserName, permissions: Readonly<Record<string, AppPermissionState>>): void {
  const where = `target "${targetName}" app.permissions`;
  rejectUnknownKeys(`${where} on ${browser}`, permissions, BROWSER_PERMISSIONS[browser]);
  for (const [name, state] of Object.entries(permissions)) {
    if (state !== 'grant') {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where}.${name} is ${state}, but a web() target only grants; leave the permission out instead`,
      );
    }
  }
}

/** The permission names a context on `browser` is granted: each one `browser` grants for `'all'` (`allPermissions`), else the map's names. */
export function grantedPermissions(browser: BrowserName, app: Pick<EngineAppInfo, 'permissions' | 'allPermissions'>): readonly string[] {
  return app.allPermissions === true ? BROWSER_PERMISSIONS[browser] : Object.keys(app.permissions ?? {});
}

/**
 * Grants `names` on a context. A browser older than the list (a CDP attach to
 * an older Chrome) refuses the whole call over one permission type it does
 * not know. For `'all'` (`skipUnknown`) that name is left out and the rest
 * granted; a named grant keeps the refusal, since the user can drop the name.
 * Playwright keeps a refused name among the context's grants, so the context's
 * grants are cleared before each retry; this runs on a fresh context, before
 * anything else is granted on it.
 */
export async function grantPermissions(
  context: { grantPermissions(permissions: string[]): Promise<void>; clearPermissions(): Promise<void> },
  names: readonly string[],
  skipUnknown: boolean,
): Promise<void> {
  let left = [...names];
  while (left.length > 0) {
    try {
      await context.grantPermissions(left);
      return;
    } catch (error) {
      const unknown = skipUnknown ? unknownPermission(error, left) : undefined;
      if (unknown === undefined) throw error;
      left = left.filter((name) => name !== unknown);
      await context.clearPermissions();
    }
  }
}

/**
 * The name among `names` a browser refused as an unknown permission type, which Playwright sends
 * camel-cased (`localNetworkAccess`). Only names whose protocol type is their camel-cased web name match
 * (the ones new in recent Chrome: `localNetworkAccess`, `storageAccess`, `localFonts`); a refused
 * `wakeLockScreen`, `clipboardSanitizedWrite`, `videoCapture` or `sensors` still fails `'all'`.
 */
function unknownPermission(error: unknown, names: readonly string[]): string | undefined {
  const type = /Unknown permission type: ([A-Za-z]+)/.exec(error instanceof Error ? error.message : '')?.[1];
  if (type === undefined) return undefined;
  return names.find((name) => name === type || name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()) === type);
}
