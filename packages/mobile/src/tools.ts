/**
 * Agent-side tools for device targets. Everything a model plans through
 * beyond the grammar verbs the engine already unlocks (tap, type, scroll,
 * screenshot, tap_at) lives here: opening another app, a free-form swipe,
 * typing into the focused field, system alerts, the TV remote, and the hinge
 * of a foldable. Each tool is scoped to
 * the platforms of the engines it was built from, so a mixed suite never
 * offers it on a browser.
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import { defineTool, type DefinedTool, type ToolAnnotations } from '@e2e-dev/core/agent';
import { EngineError, TestError, type EngineHandle } from '@e2e-dev/core/engine';
import { rawSession, type DeviceSession } from './device.ts';
import { surfaceOf } from './engine.ts';
import { isAppNotInstalled } from './errors.ts';
import { pressRemote, REMOTE_KEYS } from './remote.ts';
import type { AgentDeviceSurface, FoldPose } from './surface.ts';

/**
 * Types a tool the way the SDK's `tool()` does, without importing it: `ai`
 * is an optional peer dependency, and this module loads with the project's
 * config, so it must not need the package at run time.
 */
function deviceTool<INPUT>(definition: Tool<INPUT, string>): Tool<INPUT, string> {
  return definition;
}

function requireSurface(engine: EngineHandle): AgentDeviceSurface {
  const surface = surfaceOf(engine);
  if (surface === undefined) {
    throw new EngineError('INVALID_STATE', 'device tools need handles returned by mobile()', {
      retryable: false,
    });
  }
  return surface;
}

/**
 * The one surface whose attempt is running. A worker runs one attempt at a
 * time, so a tool call made inside a step belongs to that attempt.
 */
function runningSurface(surfaces: readonly AgentDeviceSurface[]): AgentDeviceSurface {
  const running = surfaces.filter((surface) => surface.attemptRunning);
  const [surface] = running;
  if (surface === undefined || running.length > 1) {
    throw new EngineError(
      'INVALID_STATE',
      running.length === 0
        ? 'no mobile attempt is running; device tools act inside a test attempt only'
        : 'several mobile attempts are running in one worker; tools cannot pick a device',
      { retryable: false },
    );
  }
  return surface;
}

/**
 * The running attempt's raw driver session, for a custom tool that needs
 * capabilities e2e does not wrap yet: the object a test reads from `device.unstable_raw`,
 * with a client bound to the engine's daemon, lease, and session. Pass every
 * device engine the config declares. Outside an attempt it throws
 * `INVALID_STATE`. Client calls are not steps, and like `unstable_raw` this
 * can change in any release.
 */
export function unstable_deviceSession(...engines: readonly [EngineHandle, ...EngineHandle[]]): DeviceSession {
  return rawSession(runningSurface(engines.map(requireSurface)));
}

/** The app the target pins for `app.open()`, which `open_app` returns to when the model names none. */
function appUnderTest(surface: AgentDeviceSurface): string {
  const app = surface.pinnedApp;
  if (app === undefined) {
    throw new EngineError(
      'INVALID_STATE',
      "this target pins no app under test (no app.bundleId or app.appPath), so open_app needs the app's bundle id, package, or display name",
      { retryable: false },
    );
  }
  return app;
}

const abort = (options: { abortSignal?: AbortSignal }): AbortSignal | undefined => options.abortSignal;

/** What every tool of a pack shares: the surface whose attempt is running, and the platforms the pack is offered on. */
function pack(engines: readonly EngineHandle[]): { active(): AgentDeviceSurface; annotate(mutates: boolean): ToolAnnotations } {
  const surfaces = engines.map(requireSurface);
  const platforms = [...new Set(surfaces.map((surface) => surface.options.platform))];
  return {
    active: () => runningSurface(surfaces),
    annotate: (mutates) => ({ mutates, platforms }),
  };
}

/**
 * Builds the tool pack for one or more agent-device engines, keyed the way
 * an agents entry's `tools` expects. Pass every device engine a config
 * declares: tool names are fixed, so two packs cannot be merged, and each
 * tool is offered only on the platforms those engines drive. A worker runs
 * one attempt at a time, so at execution the pack dispatches to the surface
 * whose attempt is running.
 *
 * Mutating tools are recorded as replay gaps by the trace cache; a step that
 * stays within the grammar verbs replays zero-turn, so prefer the target's
 * `app.bundleId` over `open_app` when a test always starts in the same app.
 */
export function mobileTools(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const { active, annotate } = pack(engines);

  return {
    open_app: defineTool(
      deviceTool({
        description:
          'Bring an app to the foreground. Omit app to return to the app under test, e.g. after a system sheet or another app took over the screen; pass a bundle id, package, or display name (e.g. "Settings") only for another app. Set relaunch to restart it fresh. Takes an app, not a URL: a link is refused.',
        inputSchema: z.object({ app: z.string().min(1).optional(), relaunch: z.boolean().optional() }),
        execute: async ({ app, relaunch }, options) => {
          const surface = active();
          const target = app ?? appUnderTest(surface);
          try {
            await surface.openApp(target, { relaunch: relaunch === true }, abort(options) ?? new AbortController().signal);
          } catch (error) {
            if (app === undefined || !isAppNotInstalled(error)) throw error;
            throw new TestError(
              'INVALID_ARGUMENT',
              `open ${target} failed: no installed app matches that name. Omit app to return to the app under test, or pass an installed app's exact bundle id or package.`,
              { retryable: false, cause: error },
            );
          }
          return app === undefined ? `Opened the app under test (${target}).` : `Opened ${app}.`;
        },
      }),
      annotate(true),
    ),
    swipe: defineTool(
      deviceTool({
        description:
          'Swipe from one screen point to another in logical pixels, e.g. to reveal a row action (swipe the row far left) or to dismiss a sheet.',
        inputSchema: z.object({
          from: z.object({ x: z.number(), y: z.number() }),
          to: z.object({ x: z.number(), y: z.number() }),
        }),
        execute: async ({ from, to }, options) => {
          await active().command('swipe', (client) => client.interactions.swipe({ from, to }), abort(options));
          return `Swiped from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`;
        },
      }),
      annotate(true),
    ),
    alert: defineTool(
      deviceTool({
        description:
          'Accept or dismiss a visible system alert or permission prompt. Use it when the alert\'s buttons are not listed on screen; a listed button tapped by id is the same tap and replays from the trace cache, this tool does not.',
        inputSchema: z.object({ action: z.enum(['accept', 'dismiss']) }),
        execute: async ({ action }, options) => {
          const surface = active();
          await surface.command('alert', (client) => client.command.alert({ ...surface.selection(), action }), abort(options));
          return `Alert ${action}ed.`;
        },
      }),
      annotate(true),
    ),
  };
}

/**
 * The TV remote as an agent tool, for engines that drive an Android TV or an
 * Apple TV: spread it beside `mobileTools`. It is a pack of its own, so a
 * config with no TV offers no remote. Tools are offered by platform: when a
 * phone target shares the TV's platform, put the pack on a named agent that
 * the TV tests select.
 */
export function tvTools(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const { active, annotate } = pack(engines);
  return {
    tv_remote: defineTool(
      deviceTool({
        description:
          "Press a button on the TV's remote, up to 20 times in one call. A TV has no touch screen: the D-pad (up, down, left, right) moves the focus and select activates what is focused. back and menu leave a screen, home opens the launcher, and the media keys control playback (an Apple TV has none).",
        inputSchema: z.object({ key: z.enum(REMOTE_KEYS), times: z.number().int().min(1).max(20).optional() }),
        execute: async ({ key, times = 1 }, options) => {
          const surface = active();
          const signal = abort(options) ?? new AbortController().signal;
          for (let pressed = 0; pressed < times; pressed += 1) {
            await surface.screenCommand('tv_remote', (client) => pressRemote(client, key, surface.selection()), signal);
          }
          return times === 1 ? `Pressed ${key} on the remote.` : `Pressed ${key} on the remote ${String(times)} times.`;
        },
      }),
      annotate(true),
    ),
  };
}

/** The poses `fold` takes, the ones `device.fold` accepts. */
const FOLD_POSES = ['closed', 'half-open', 'open'] as const satisfies readonly FoldPose[];

/** What `fold` answers once the device is in a pose. */
const FOLDED: Readonly<Record<FoldPose, string>> = {
  closed: 'Folded the device closed; the app is on the outer display.',
  'half-open': 'Folded the device half-open; the app is on the inner display.',
  open: 'Unfolded the device flat; the app is on the inner display.',
};

/**
 * The hinge as an agent tool, for engines that drive a foldable: the iPhone
 * Duo simulator or a foldable Android emulator. Spread it beside
 * `mobileTools`. It is a pack of its own, so a config with no foldable offers
 * no hinge. Tools are offered by platform: when a device without a hinge
 * shares the foldable's platform, put the pack on a named agent that the
 * foldable tests select, since that device answers `UNSUPPORTED_CAPABILITY`.
 */
export function foldTools(
  ...engines: readonly [EngineHandle, ...EngineHandle[]]
): Readonly<Record<string, DefinedTool>> {
  const { active, annotate } = pack(engines);
  return {
    fold: defineTool(
      deviceTool({
        description:
          'Fold or unfold a foldable device. closed puts the app on the outer (cover) display, open lays the inner display flat, and half-open bends it like a book. The app moves to the other display and can change its layout, so read the screen again before the next action. On the iPhone Duo simulator a fold takes 10 to 16 seconds.',
        inputSchema: z.object({ pose: z.enum(FOLD_POSES) }),
        execute: async ({ pose }, options) => {
          await active().fold(pose, abort(options) ?? new AbortController().signal);
          return FOLDED[pose];
        },
      }),
      annotate(true),
    ),
  };
}
