/**
 * Translation of agent-device failures onto the engine error contract.
 *
 * | agent-device failure                                        | Code                         |
 * | ----------------------------------------------------------- | ---------------------------- |
 * | already an EngineError / runner error                       | passed through untouched     |
 * | AbortError                                                  | CANCELLED                    |
 * | SESSION_NOT_FOUND, or a session-or-device-selector refusal  | INVALID_STATE                |
 * | UNSUPPORTED_OPERATION, NOT_IMPLEMENTED, UNSUPPORTED_PLATFORM | UNSUPPORTED_CAPABILITY      |
 * | "not supported on this device" under any code                | UNSUPPORTED_CAPABILITY       |
 * | a stale-ref refusal by `details.reason` (action paths only)  | NODE_STALE (retryable)        |
 * | target_still_moving with `details.dispatched: no`            | NODE_STALE (retryable)        |
 * | a covered or keyboard-occluded target, `dispatched: no`      | NOT_ACTIONABLE, with the hint |
 * | a target with no screen origin to aim at, `dispatched: no`   | NOT_ACTIONABLE, with the hint |
 * | screen.swipe({ from, to }) off agent-device's viewport       | NOT_ACTIONABLE, with the hint |
 * | the iOS runner busy, wedged, or past its watchdog           | ENGINE_FAILURE, naming the   |
 * | a snapshot the iOS runner acquired but could not present    |   runner and the recovery    |
 * | anything else, agent-device's own timeouts included         | ENGINE_FAILURE with the text |
 *
 * `OPERATION_TIMEOUT` is never produced here. In the contract it means the
 * operation budget expired: `InputBudget` (support.ts) reports it for an input
 * the budget ran out before, and `ACTION_MAY_HAVE_COMMITTED` for one sent that
 * did not answer in time. Core replaces the timeout's message with a bare
 * `operation timed out`. A timeout
 * agent-device itself reports (a simulator boot, the runner connecting, an
 * app launch) is a device-side fault whose text is the diagnosis, so it
 * stays `ENGINE_FAILURE` and keeps its message and hint.
 */

import { isAgentDeviceError, normalizeAgentDeviceError } from 'agent-device';
import { defaultHintForCode } from 'agent-device/contracts';
import { EngineError, ConfigurationError, InfrastructureError, TestError, raceAbort, type ViewportSize } from '@e2e-dev/core/engine';
import { cancelled } from './support.ts';

/**
 * True for an error that already carries its classification: an `EngineError`
 * from any module copy, or a runner error. Those cross the boundary untouched;
 * re-wrapping one would turn a `POLICY_DENIED` into an infrastructure failure.
 */
function isClassified(cause: unknown): cause is Error {
  if (cause instanceof EngineError || cause instanceof TestError) return true;
  if (cause instanceof ConfigurationError || cause instanceof InfrastructureError) return true;
  return cause instanceof Error && cause.name === 'EngineError';
}

/** A failure's message in agent-device's normalized form. */
export function message(cause: unknown): string {
  return normalizeAgentDeviceError(cause).message;
}

/** The details bag the failure itself declared; the normalizer lifts some keys off it, so it is read raw. */
function details(cause: unknown): Record<string, unknown> {
  return isAgentDeviceError(cause) ? (cause.details ?? {}) : {};
}

/**
 * The normalized message followed by the hint the failure itself declared.
 * That hint is the recovery path (press return, tap the app's own Done
 * control) and the model only ever sees the error text, so dropping it leaves
 * the agent retrying the same refused action. The per-code default hint is
 * CLI advice (`Run apps to discover...`) and stays out, also when the daemon
 * carries it over in `details.hint`.
 */
function withHint(cause: unknown, text: string): string {
  const hint = details(cause).hint;
  if (typeof hint !== 'string' || hint.trim() === '' || CLI_ADVICE.test(hint)) return text;
  if (hint === defaultHintForCode(normalizeAgentDeviceError(cause).code)) return text;
  return `${text} Hint: ${hint.trim()}`;
}

/** agent-device's generic hint (`Check command arguments and run --help`) is CLI advice, and stays out too. */
const CLI_ADVICE = /--help|command arguments/i;

const UNSUPPORTED_CODES = new Set(['UNSUPPORTED_OPERATION', 'NOT_IMPLEMENTED', 'UNSUPPORTED_PLATFORM']);
const UNSUPPORTED_PATTERN = /\b(?:is )?not supported\b|\bunsupported\b/i;

/**
 * The `details.reason` agent-device refuses a command with when it has no
 * session and no device selector to fall back on (0.21.21).
 */
const NO_SESSION_REASON = 'session_or_device_selector_required';

/**
 * The `details.reason` values agent-device refuses an `@ref` with: the ref
 * names no node of the session's tree, or belongs to a capture the session
 * has since moved past (a newer snapshot, or an action that expired its refs).
 * agent-device raises each one while resolving or admitting the ref, before
 * the action reaches the device.
 */
const STALE_REF_REASONS: ReadonlySet<string> = new Set([
  'ref_not_found',
  'ref_frame_expired',
  'ref_generation_mismatch',
  'plain_ref_requires_complete_frame',
  'ref_not_issued',
]);

/**
 * The snapshot warning agent-device 0.21.37 adds, word for word, when a
 * capture could not place its window on the screen. It refuses its own ref
 * actions on that capture with `window-origin-unknown`, but takes points a
 * caller sends, so a gesture aimed from the capture's rects is checked here.
 */
export const ORIGIN_WARNING =
  'This snapshot cannot establish the window origin on screen. Coordinate-derived element interactions are unavailable until a capture measures the viewport.';

/** What that capture means for a caller, after "The " or "the ": the one wording a refused tap and a refused node swipe share. */
export const ORIGIN_UNKNOWN_BOUNDS =
  "app's window has no known position on the screen, so node bounds, boundingBox() included, may be offset from screen coordinates.";

/**
 * The `details.reason` values agent-device refuses an action with, nothing
 * sent, on a healthy device, each with the hint the failure carries:
 * `undefined` keeps agent-device's own, and a string replaces it.
 *
 * - `target_covered`, `tap_keyboard_occludes_target`: an overlay its
 *   occlusion scan found over the target (`coveredBy` names it), or the soft
 *   keyboard over the target's touch point. The test has to move the cover
 *   or the target first, and agent-device's hint says how.
 * - `window-origin-unknown` (0.21.37): the capture the ref came from could not
 *   place its window on the screen, so its bounds may be offset from screen
 *   coordinates by the window's position (a placed iPad window). agent-device's
 *   hint names its CLI (`snapshot`, `screenshot`); a point tap is not aimed
 *   from the capture, and agent-device takes it, but a point read from
 *   `boundingBox()` carries the same offset.
 */
const NOT_ACTIONABLE_REASONS: ReadonlyMap<string, string | undefined> = new Map([
  ['target_covered', undefined],
  ['tap_keyboard_occludes_target', undefined],
  [
    'window-origin-unknown',
    `Nothing was sent. The ${ORIGIN_UNKNOWN_BOUNDS} For a tap, tap a screen point with screen.tapAt(), not one taken from those bounds.`,
  ],
]);

/**
 * What the iOS automation runner reported about itself, by the code
 * agent-device emits for it: `RUNNER_WEDGED` at the top level, `RUNNER_BUSY`
 * and `MAIN_THREAD_TIMEOUT` in `details.runnerErrorCode` under
 * `COMMAND_FAILED`, the shape the daemon folds runner wire codes into. Each
 * value is the headline and the first move; the app is fine in every case.
 */
const RUNNER_STATE: ReadonlyMap<string, { readonly headline: string; readonly firstMove: string }> = new Map([
  [
    'RUNNER_BUSY',
    {
      headline: 'the iOS automation runner is still finishing a command that overran its watchdog',
      firstMove: 'Wait a few seconds and rerun.',
    },
  ],
  [
    'MAIN_THREAD_TIMEOUT',
    {
      headline: "the iOS automation runner's main thread overran its watchdog on this command",
      firstMove: 'Rerun once it has drained.',
    },
  ],
  [
    'RUNNER_WEDGED',
    {
      headline: 'the iOS automation runner is wedged: its main thread is stuck in abandoned work',
      firstMove: 'agent-device restarts the runner; rerun.',
    },
  ],
]);

/**
 * A snapshot the iOS runner acquired but could not present. Upstream raises
 * it as `IOS_SNAPSHOT_ENGINE_FAILED` and rethrows it to the client as
 * `COMMAND_FAILED` with the check that failed in `details.reason`: a
 * per-capture presentation check, not a property of the app or the screen.
 * The reasons are agent-device's (`ios-snapshot-runtime`,
 * `runner-presentation`): the viewport checks, a malformed graph, which the
 * presenter rewraps as `invalid-presented-payload` on the presented tree and
 * `invalid-quality-payload` on the quality tree, and the payload checks it
 * raises as `invalid-presented-payload` directly (a parent outside the
 * payload, a disabled or off-viewport node marked actionable).
 */
const PRESENTATION_CODE = 'IOS_SNAPSHOT_ENGINE_FAILED';
const PRESENTATION_REASONS = new Set([
  'invalid-viewport',
  'missing-viewport',
  'malformed-graph',
  'invalid-presented-payload',
  'invalid-quality-payload',
]);
const PRESENTATION = {
  headline: 'the iOS automation runner could not present the accessibility snapshot',
  firstMove: 'Rerun.',
};

/**
 * The `details.androidSnapshotHelperFailureReason` values agent-device gives
 * up on a capture with when the foreground holds too little to read: the
 * helper returned nothing, only a system window, or an app window with almost
 * no content. A cold-starting app on a slow emulator does this until it
 * renders. Mirrors agent-device's `isUnreadableCaptureContentError`, which
 * its root entry does not export (0.21.25).
 */
const UNREADABLE_CAPTURE_REASONS: ReadonlySet<string> = new Set([
  'empty-helper-output',
  'system-window-only',
  'content-poor-app-window',
]);

const RUNNER_RECOVERY =
  'If the next run meets it again, stop the daemon (`npx agent-device daemon stop`) and reboot the simulator (`xcrun simctl shutdown <udid>`, then `boot`).';

/** The runner-state entry for a failure, by top-level code or the folded runner wire code. */
function runnerState(cause: unknown): { readonly headline: string; readonly firstMove: string } | undefined {
  const normalized = normalizeAgentDeviceError(cause);
  const wire = details(cause).runnerErrorCode;
  return RUNNER_STATE.get(normalized.code) ?? (typeof wire === 'string' ? RUNNER_STATE.get(wire) : undefined);
}

/** True when the iOS runner acquired a snapshot and failed its own presentation check on it. */
function isPresentationFailure(cause: unknown): boolean {
  if (normalizeAgentDeviceError(cause).code === PRESENTATION_CODE) return true;
  const reason = details(cause).reason;
  return typeof reason === 'string' && PRESENTATION_REASONS.has(reason);
}

/**
 * The message for a fault of the automation runner itself: what the runner
 * is doing, where (the session and device when the caller knows them),
 * agent-device's own text, then the recovery. The harness reports an engine
 * fault under the agent as `APP_UNREACHABLE`, so the message has to say the
 * app is not the part that failed.
 */
function runnerMessage(
  operation: string,
  where: string | undefined,
  state: { readonly headline: string; readonly firstMove: string },
  cause: unknown,
): string {
  const location = where === undefined ? '' : ` (${where})`;
  return `${operation} failed: ${state.headline}${location}: ${message(cause)} The app is fine. ${state.firstMove} ${RUNNER_RECOVERY}`;
}

/** Whether agent-device refused a command because its session does not exist: closed already, or never opened. */
export function isNoSession(cause: unknown): boolean {
  return normalizeAgentDeviceError(cause).code === 'SESSION_NOT_FOUND' || details(cause).reason === NO_SESSION_REASON;
}

/**
 * Translates an unexpected agent-device error at the contract boundary.
 * `where` names the session and device the command ran under, for the
 * messages whose recovery is per device.
 */
export function translateError(cause: unknown, operation: string, where?: string): Error {
  if (isClassified(cause)) return cause;
  if (cause instanceof Error && cause.name === 'AbortError') return cancelled(`${operation} cancelled`);
  const normalized = normalizeAgentDeviceError(cause);
  const text = `${operation} failed: ${withHint(cause, normalized.message)}`;
  const options = { retryable: false, cause };
  if (isNoSession(cause)) {
    return new EngineError('INVALID_STATE', text, options);
  }
  if (UNSUPPORTED_CODES.has(normalized.code) || UNSUPPORTED_PATTERN.test(normalized.message)) {
    return new EngineError('UNSUPPORTED_CAPABILITY', text, options);
  }
  const state = runnerState(cause);
  if (state !== undefined) return new EngineError('ENGINE_FAILURE', runnerMessage(operation, where, state, cause), options);
  if (isPresentationFailure(cause)) {
    return new EngineError('ENGINE_FAILURE', runnerMessage(operation, where, PRESENTATION, cause), options);
  }
  return new EngineError('ENGINE_FAILURE', text, options);
}

/**
 * True for a translated failure of the iOS automation runner itself: busy,
 * wedged, or past its watchdog. The runner, not the app, is what needs
 * attention, so a caller that tolerates an app that did not open (warm-up)
 * must not tolerate this.
 */
export function isRunnerFailure(error: unknown): boolean {
  return error instanceof Error && runnerState(error.cause) !== undefined;
}

/**
 * True for a translated snapshot the iOS runner acquired but could not
 * present. The check is per capture and the capture is a read, so one retry
 * is safe and usually enough.
 */
export function isSnapshotPresentationFailure(error: unknown): boolean {
  return error instanceof Error && isPresentationFailure(error.cause);
}

/**
 * True for a translated snapshot agent-device took on Android but found too
 * little foreground content in to read. The screen is still arriving, so a
 * caller that polls may read it as nothing there yet.
 */
export function isUnreadableCapture(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const reason = details(error.cause).androidSnapshotHelperFailureReason;
  return typeof reason === 'string' && UNREADABLE_CAPTURE_REASONS.has(reason);
}

/**
 * True for a translated read the iOS runner refused because XCTest sees the
 * app as not running. A physical device answers `devicectl` launch before
 * that state catches up, so this follows an `open` or `restart` for a
 * moment; any other time the app has exited.
 */
export function isAppNotRunning(error: unknown): boolean {
  return error instanceof Error && details(error.cause).runnerErrorCode === 'APP_NOT_RUNNING';
}

/**
 * The `DEVICE_IN_USE` reasons that mean another live session holds the
 * device: a claim agent-device verified, a workspace session, or a session of
 * the same daemon, which carries no reason. A dead owner awaiting recovery, a
 * claim it cannot verify, and a device under human control or provider
 * release are left out: each comes with its own advice.
 */
const LIVE_HOLDER_REASONS: ReadonlySet<unknown> = new Set([undefined, 'DEVICE_CLAIM_LIVE_OWNER', 'WORKSPACE_SESSION_SCOPE_CONFLICT']);

/**
 * How agent-device names the claim one command (boot, prepare, install, push)
 * takes for its own length: `transient:<command>`. It ends with the command.
 */
const TRANSIENT_HOLDER = 'transient:';

/**
 * The session holding the device, for a translated command agent-device
 * refused because another live session holds that device, as its claim
 * (`owner.session`) or its daemon (`session`) names it, a short-lived
 * command's claim included; `undefined` for any other failure.
 */
export function deviceHolder(error: unknown): string | undefined {
  if (!(error instanceof Error) || !isAgentDeviceError(error.cause) || normalizeAgentDeviceError(error.cause).code !== 'DEVICE_IN_USE') return undefined;
  const { reason, owner, session } = details(error.cause);
  if (!LIVE_HOLDER_REASONS.has(reason)) return undefined;
  const holder = typeof owner === 'object' && owner !== null ? (owner as { session?: unknown }).session : session;
  return typeof holder === 'string' ? holder : undefined;
}

/**
 * True when `deviceHolder` reads a short-lived command's claim: agent-device
 * writes `transient:<command>` only as a claim refusal's `owner.session`, and
 * the claim ends with the command. A session of the same daemon or a
 * workspace session is a live holder whatever its name.
 */
export function isShortLivedClaim(error: unknown): boolean {
  if (deviceHolder(error) === undefined || !(error instanceof Error)) return false;
  const { owner } = details(error.cause);
  const session = typeof owner === 'object' && owner !== null ? (owner as { session?: unknown }).session : undefined;
  return typeof session === 'string' && session.startsWith(TRANSIENT_HOLDER);
}

/** True for a translated `open` agent-device refused because no installed app matches the name. */
export function isAppNotInstalled(error: unknown): boolean {
  return error instanceof Error && isAgentDeviceError(error.cause) && normalizeAgentDeviceError(error.cause).code === 'APP_NOT_INSTALLED';
}

/**
 * Runs one agent-device command under an abort signal and translates its
 * failure onto the engine taxonomy: the one boundary every command crosses.
 */
export async function runCommand<T>(label: string, work: () => Promise<T>, signal: AbortSignal, where?: string): Promise<T> {
  try {
    return await raceAbort(work, signal, label);
  } catch (cause) {
    throw translateError(cause, label, where);
  }
}

/**
 * The `details.reason` agent-device refuses a gesture with, before anything is
 * sent, when a point of its path leaves the viewport it checks against: the
 * rect in `details.viewport`, the refused point in `details.sample.point`.
 * On iOS that rect stops at the open soft keyboard's top edge for a swipe and
 * keeps the screen's full width, while since agent-device 0.21.42 a timed
 * pan's rect keeps the keyboard in it.
 */
const OUT_OF_BOUNDS_REASON = 'GESTURE_TRAJECTORY_OUT_OF_BOUNDS';

function rectIn(value: unknown): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { x, y, width, height } = value as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number' ? { x, y, width, height } : undefined;
}

/**
 * A `screen.swipe({ from, to })` agent-device refused for a path outside its
 * viewport: `NOT_ACTIONABLE`, since nothing was sent and the device is fine.
 * The hint names `duration` only when the keyboard is what refused it: an
 * untimed swipe whose refused point lies inside the screen (`screen`, read
 * fresh, with agent-device's 1-point inset) but below the viewport's cut
 * bottom edge, the only point a timed pan would take. Any other refusal keeps
 * agent-device's own hint (an edge point, screenshot pixels), and an error
 * with another reason is returned unchanged.
 */
export async function refusedSwipePath(cause: unknown, operation: string, timed: boolean, screen: () => Promise<ViewportSize>): Promise<unknown> {
  const { reason, viewport, sample } = details(cause);
  if (reason !== OUT_OF_BOUNDS_REASON) return cause;
  const checked = rectIn(viewport);
  const point = typeof sample === 'object' && sample !== null ? (sample as Record<string, unknown>).point : undefined;
  const at = typeof point === 'object' && point !== null ? (point as Record<string, unknown>) : {};
  const { x, y } = at;
  const belowCut = !timed && checked !== undefined && typeof x === 'number' && typeof y === 'number' &&
    x >= checked.x + 1 && x <= checked.x + checked.width && y > checked.y + checked.height;
  const size = belowCut ? await screen().catch(() => undefined) : undefined;
  const keyboardCut = size !== undefined && checked !== undefined && typeof y === 'number' &&
    checked.width === size.width && checked.height < size.height && y <= size.height - 1;
  const text = keyboardCut
    ? `${message(cause)} Hint: Nothing was sent. The open soft keyboard cuts the ${size.height}-point screen to that viewport for a swipe with no duration; pass duration to send the path as given, across the keyboard.`
    : withHint(cause, message(cause));
  return new EngineError('NOT_ACTIONABLE', `${operation} failed: ${text}`, { retryable: false, cause });
}

/**
 * Like translateError, but a ref agent-device refused as stale becomes
 * retryable `NODE_STALE`: nothing was dispatched, so the harness may
 * re-observe and re-resolve the node instead of failing the action. Existing
 * stale-ref reasons are sufficient on their own: Android dialog recovery can
 * mark a refused drag as `dispatched: unknown`. A `target_still_moving` refusal
 * additionally requires `dispatched: no`; missing or unknown dispatch is not retryable.
 * A target agent-device refused for a reason in `NOT_ACTIONABLE_REASONS` with
 * nothing dispatched is `NOT_ACTIONABLE`, with the move that gets past it: an
 * action failure on a healthy device, never an infrastructure one.
 */
export function staleOr(cause: unknown, operation: string, where?: string): Error {
  if (isClassified(cause)) return cause;
  const { reason, dispatched } = details(cause);
  if ((typeof reason === 'string' && STALE_REF_REASONS.has(reason)) ||
      (reason === 'target_still_moving' && dispatched === 'no')) {
    return new EngineError('NODE_STALE', `${operation}: ${message(cause)}`, { retryable: true, cause });
  }
  if (typeof reason === 'string' && NOT_ACTIONABLE_REASONS.has(reason) && dispatched === 'no') {
    const hint = NOT_ACTIONABLE_REASONS.get(reason);
    const text = hint === undefined ? withHint(cause, message(cause)) : `${message(cause)} Hint: ${hint}`;
    return new EngineError('NOT_ACTIONABLE', `${operation} failed: ${text}`, { retryable: false, cause });
  }
  return translateError(cause, operation, where);
}
