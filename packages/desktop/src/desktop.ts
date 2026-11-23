/**
 * The `desktop` fixture: what a test asks of the desktop itself rather than
 * of a control on screen. The harness records each call as a
 * `desktop.<method>` step bounded by the action timeout.
 */

import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import type { DesktopPlatform } from './options.ts';
import type { DesktopSurface, DesktopWindow } from './surface.ts';

/** Deterministic desktop management exposed to tests as `desktop`. */
export interface Desktop {
  /** The OS the app runs on. */
  readonly platform: DesktopPlatform;
  /** The app's open windows, the focused one marked. */
  windows(): Promise<readonly DesktopWindow[]>;
  /**
   * Reads and acts in this window from now on, rather than the focused one,
   * until the app quits: a panel or bubble that takes focus then cannot hide
   * the window the test is about. With no window, goes back to the focused
   * one.
   */
  useWindow(window?: DesktopWindow | string): Promise<void>;
  /** Quits the app. `app.open()` launches it again; every test ends with it quit. */
  closeApp(): Promise<void>;
}

export function createDesktopFixture(surface: DesktopSurface, context: EngineFixtureContext): Desktop {
  const desktop: Desktop = {
    platform: surface.platform,
    async windows() {
      const operation = context.operation();
      return await surface.windows(operation.signal, operation.timeoutMs);
    },
    async useWindow(window) {
      const operation = context.operation();
      await surface.useWindow(typeof window === 'string' ? window : window?.id, operation.signal, operation.timeoutMs);
    },
    async closeApp() {
      const operation = context.operation();
      await surface.closeApp(operation.signal, operation.timeoutMs);
    },
  };
  return context.fixture('desktop', desktop, {
    windows: { kind: 'resource' },
    useWindow: { kind: 'resource' },
    closeApp: { kind: 'resource' },
  });
}
