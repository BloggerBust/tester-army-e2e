/**
 * What the desktop engine is given: its options, and the platform it runs on.
 * The app under test is the target's `app` (`bundleId`, `appPath`,
 * `launchArguments`); these options only say how agent-desktop drives it.
 */

import { ConfigurationError, rejectUnknownKeys } from '@e2e-dev/core/engine';

/** The desktop operating system the engine drives, as its platform label: macOS only for now. */
export type DesktopPlatform = 'macos';

/**
 * Options of the desktop engine. Every optional value also accepts
 * `undefined`, so values read straight from `process.env` need no
 * conditional spread.
 */
export interface DesktopOptions {
  /**
   * Path to an agent-desktop executable to use instead of the pinned release
   * the engine downloads on the first run. The executable's helper (on macOS
   * `agent-desktop-macos-helper`) must sit beside it, as in a release archive
   * or a Homebrew install.
   */
  readonly binary?: string | undefined;
  /**
   * What an observation captures. `full` (default) includes static text, so
   * judgments can read labels; `interactive` keeps only the controls
   * agent-desktop gives a ref. Locators read the whole window either way.
   */
  readonly snapshot?: 'full' | 'interactive' | undefined;
  /**
   * Allows physical input: the real pointer and keyboard, which take focus
   * and move the cursor. Off by default: every action goes through the
   * accessibility API and leaves the user's pointer and focus alone, and
   * the app stays in the background. On, `app.open()` brings the app
   * forward, which some apps need before they show a window, and the
   * engine also offers `doubleTap`, `hover`, `press`, point-addressed taps,
   * and keystrokes into whatever has focus (the keyboard capability).
   */
  readonly headed?: boolean | undefined;
  /**
   * How long the engine waits after an action the agent took before the agent
   * observes again, in milliseconds; `false` skips the wait. A test's own
   * steps never wait: `expect` polls their outcome. Default 150.
   */
  readonly settle?: number | false | undefined;
  /**
   * How many levels of a window's accessibility tree a read goes down, from
   * 1 to 50. A read cut short at this depth cannot prove a control absent or
   * the only one, so a locator on such a window reads again until its
   * timeout: raise it for an app nested deeper. Default 24.
   */
  readonly maxDepth?: number | undefined;
}

const OPTION_KEYS = Object.keys({ binary: true, snapshot: true, headed: true, settle: true, maxDepth: true } satisfies Record<keyof DesktopOptions, true>);

/** The options with defaults applied, checked once at config load. */
export interface ResolvedDesktopOptions {
  readonly binary?: string;
  readonly interactiveOnly: boolean;
  readonly headed: boolean;
  readonly settleMs: number;
  readonly maxDepth: number;
}

const DEFAULT_SETTLE_MS = 150;

/** How deep a read goes by default: deeper than the controls of the apps tried, and quick to read. */
const DEFAULT_MAX_DEPTH = 24;

/** The deepest read agent-desktop takes: its macOS reader stops at 50 levels and refuses a deeper `--max-depth`. */
const MAX_DEPTH_LIMIT = 50;

/** Checks the option bag the way every config option is checked: unknown keys and wrong types fail the config load. */
export function resolveOptions(options: DesktopOptions | undefined): ResolvedDesktopOptions {
  // Only a missing bag defaults: a null one (from JSON an agent wrote for e2e mcp) is a config error, not the defaults.
  const bag: DesktopOptions = options === undefined ? {} : options;
  if (typeof bag !== 'object' || bag === null) throw new ConfigurationError('INVALID_CONFIG', 'desktop() options must be an object');
  rejectUnknownKeys('desktop() options', bag, OPTION_KEYS);
  const { binary, snapshot, headed, settle, maxDepth } = bag;
  if (binary !== undefined && (typeof binary !== 'string' || binary === '')) {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ binary }) must be a path to an agent-desktop executable');
  }
  if (snapshot !== undefined && snapshot !== 'full' && snapshot !== 'interactive') {
    throw new ConfigurationError('INVALID_CONFIG', `desktop({ snapshot }) must be 'full' or 'interactive', got ${JSON.stringify(snapshot)}`);
  }
  if (headed !== undefined && typeof headed !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ headed }) must be a boolean');
  }
  if (settle !== undefined && settle !== false && (!Number.isInteger(settle) || settle < 0)) {
    throw new ConfigurationError('INVALID_CONFIG', 'desktop({ settle }) must be a whole number of milliseconds, or false');
  }
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH_LIMIT)) {
    throw new ConfigurationError('INVALID_CONFIG', `desktop({ maxDepth }) must be a whole number from 1 to ${MAX_DEPTH_LIMIT}`);
  }
  return {
    ...(binary === undefined ? {} : { binary }),
    interactiveOnly: snapshot === 'interactive',
    headed: headed === true,
    settleMs: settle === false ? 0 : (settle ?? DEFAULT_SETTLE_MS),
    maxDepth: maxDepth ?? DEFAULT_MAX_DEPTH,
  };
}

/**
 * Fails on any OS but macOS. agent-desktop also runs on Windows and Linux,
 * but there some of the engine's actions need physical input and secure
 * fields are not always reported, so the engine refuses them until they are
 * tested.
 */
export function requireMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new ConfigurationError('INVALID_CONFIG', `desktop() drives macOS apps only for now; this machine runs ${process.platform}`);
  }
}
