/**
 * The agent-desktop engine for e2e: a desktop body built with the public
 * `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2e-dev/core/engine` and contributes the
 * `desktop` fixture the way the browser engine contributes `browser`.
 */

import { createRequire } from 'node:module';
import { ConfigurationError, defineEngine, type EngineAppCheckInfo, type EngineAppDeclaration, type EngineHandle, type EngineIsolation, type LocatorActionKind, type PointerActionKind } from '@e2e-dev/core/engine';
import { createDesktopFixture } from './desktop.ts';
import type { DesktopFixtures } from './fixtures.ts';
import { requireMacOS, resolveOptions, type DesktopOptions } from './options.ts';
import { DesktopSurface } from './surface.ts';

/** What `perform` honors through the accessibility API alone, on macOS. */
const ACTIONS: readonly LocatorActionKind[] = ['tap', 'secondaryTap', 'fill', 'clear', 'check', 'uncheck', 'focus', 'scrollIntoView', 'selectOption', 'swipe'];

/**
 * What physical input adds: a double click and the pointer over a control
 * (agent-desktop does both with the real pointer only), a key, which
 * agent-desktop sends only to the active window, and taps at a point.
 */
const HEADED_ACTIONS: readonly LocatorActionKind[] = [...ACTIONS, 'press', 'doubleTap', 'hover'];
const HEADED_POINTER_ACTIONS: readonly PointerActionKind[] = ['tap', 'doubleTap', 'secondaryTap', 'hover'];

/**
 * The handle `desktop()` returns. Declared here so a config's inferred type
 * names this package: a project sees `@e2e-dev/core` only through its
 * dependencies, and TypeScript cannot write that path in a declaration.
 */
export interface DesktopEngine<Platform extends string = string, Isolation extends EngineIsolation = EngineIsolation>
  extends EngineHandle<DesktopFixtures, Platform, Isolation> {}

/**
 * Creates one desktop engine: it drives the target's macOS app on this
 * machine, one worker at a time. A test launches the app with `app.open()`;
 * every test ends with the app quit. A config that names it loads on any OS,
 * and its other targets run elsewhere when `--target` picks them; a run that
 * includes this target stops before any test starts on any OS but macOS.
 */
export function desktop(options: DesktopOptions = {}): DesktopEngine<'macos', 'attempt'> {
  const resolved = resolveOptions(options);
  const platform = 'macos';
  const surface = new DesktopSurface(resolved, platform);
  const headed = resolved.headed;
  return defineEngine<DesktopFixtures, 'macos', 'attempt'>({
    name: 'desktop',
    version: ownVersion(),
    spiVersion: 1,
    platform,
    workers: 1,
    launchArgumentValues: true,
    prepare: (info) => {
      requireMacOS();
      return surface.prepare(info);
    },
    doctor: async (info) =>
      process.platform === 'darwin' ? await surface.doctor(info) : [{ id: 'platform', status: 'fail' as const, message: `desktop() drives macOS apps only for now; this machine runs ${process.platform}` }],
    init: (info) => {
      requireMacOS();
      return surface.init(info);
    },
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: headed ? HEADED_ACTIONS : ACTIONS,
    ...(headed
      ? { performAt: (point, action, operation) => surface.performAt(point, action, operation), pointerActions: HEADED_POINTER_ACTIONS }
      : {}),
    // Typing into whatever has focus must send keystrokes, which agent-desktop does with physical input only.
    ...(headed
      ? {
          keyboard: {
            type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
            press: (key, operation) => surface.pressKey(key, operation),
          },
        }
      : {}),
    validateApp: (app, info) => validateApp(app, info),
    // No `open`: a desktop app has no URL, so the runner serves `app.open()`
    // with `restart`, a fresh launch of the target's app.
    session: {
      restart: (operation) => surface.restart(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
    },
    fixtures: {
      desktop: (context) => createDesktopFixture(surface, context),
    },
  });
}

/**
 * A desktop target launches an app: `bundleId` names an installed one (a
 * bundle id or an app name), or `appPath` names a built `.app` bundle.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a desktop() target drives an installed app; name it with app.bundleId or app.appPath`);
  }
  if (app.bundleId === undefined && app.appPath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs app.bundleId or app.appPath: desktop() launches an installed app, such as app: { bundleId: 'com.example.app' } or app: { appPath: 'build/Example.app' }`,
    );
  }
  if (app.appPath !== undefined && !/\.app\/?$/.test(app.appPath)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} app.appPath must name a macOS .app bundle, got ${JSON.stringify(app.appPath)}`);
  }
  if (app.permissions !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.permissions, which a desktop() target cannot set`);
  }
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
