/**
 * The `device` fixture: deterministic device management this engine
 * contributes. Not an agent tool; a test calls these directly to arrange or
 * assert device state, and the harness records each call as a
 * `device.<method>` step bounded by the action timeout.
 */

import type { AgentDeviceClient as DeviceSessionClient } from 'agent-device';
import { TestError, type EngineFixtureContext, type Locator, type ViewportSize } from '@e2e-dev/core/engine';
import { appLabel, linkLabel, linkTarget } from './links.ts';
import { pressRemote, requireRemoteKey, type RemoteKey } from './remote.ts';
import { pressButton, requireHardwareButton, type HardwareButton } from './buttons.ts';
import type { DevicePermission, MobilePlatform, PermissionState } from './options.ts';
import type { DeviceSelection } from './bindings.ts';
import { unsupported } from './support.ts';
import type { AgentDeviceSurface, FoldPose, InstallAppOptions, InstalledApp, OpenAppOptions } from './surface.ts';

/**
 * Why iOS refuses to take the device offline, before any device command:
 * agent-device's iOS `wifi` and `airplane` settings only override a
 * simulator's status bar, and a physical iPhone takes no settings at all. A
 * success would let a test read the repainted indicator as the app going
 * offline. Going back online sends nothing there, like a toggle already in
 * the wanted state, so a cleanup hook shared with Android still passes.
 */
const IOS_OFFLINE =
  "on iOS agent-device can only repaint a simulator's status bar, since the simulator shares the Mac's network, and cannot switch an iPhone's radios, so the app would stay online";

/** Orientations `setOrientation` accepts. */
export type DeviceOrientation = 'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right';

export type BiometricSensor = 'faceid' | 'touchid' | 'fingerprint';

export interface ForegroundApp {
  readonly name: string;
  readonly bundleId?: string;
}

/** The raw driver client. Unstable: its operations can change in any release. */
export type { DeviceSessionClient };

/** The raw driver session behind `device`; see `Device.unstable_raw`. */
export interface DeviceSession {
  readonly platform: MobilePlatform;
  /** The raw driver session name: `e2e-<target>-<worker slot>` (`e2e-<target>-<hostId>-<worker slot>` for a `launch()` host), or `<session>-<worker slot>` with the `session` option. */
  readonly session: string;
  /** The device id: a simulator UDID or an Android serial. */
  readonly deviceId: string;
  readonly deviceName: string;
  /** The device selection the engine passes commands; spread it into a call that can run before `app.open()`. */
  readonly selection: DeviceSelection;
  /** The raw driver client, bound to this session. */
  readonly client: DeviceSessionClient;
}

/** Deterministic device management exposed to tests as `device`. */
export interface Device {
  /**
   * The raw driver session this test drives, for what the methods here do
   * not cover. Calls through `client` bypass e2e: they are not steps, so the
   * report and trace leave them out, the agent's cache does not replay them,
   * their arguments reach the driver unredacted, and nothing waits for the
   * screen to settle after one. Unstable: it may change or go away in any
   * release.
   */
  readonly unstable_raw: DeviceSession;
  /**
   * A locator from an agent-device selector (`'id=SW_VERSION_SPECIFIER'`,
   * `'role=text label="26.2"'`), for nodes the closed `screen` query
   * vocabulary cannot name. Same polling and strictness as any locator.
   */
  locator(selector: string): Locator;
  /**
   * Switches an Android device's Wi-Fi. Cellular data stays on, so an
   * emulator hands the app over to its cellular link; `setAirplaneMode(true)`
   * cuts both. On iOS `offline` is `UNSUPPORTED_CAPABILITY`, since a
   * simulator shares the Mac's network and simctl can only repaint its status
   * bar; `online` sends nothing there, so a cleanup hook shared with Android
   * passes.
   */
  setNetwork(state: 'online' | 'offline'): Promise<void>;
  /**
   * Switches an Android device's airplane mode, Wi-Fi and cellular together;
   * Android 11 or newer. On iOS, as for `setNetwork`, `true` is
   * `UNSUPPORTED_CAPABILITY` and `false` sends nothing.
   */
  setAirplaneMode(enabled: boolean): Promise<void>;
  /**
   * Grants, denies, or resets one permission for the pinned app, which need
   * not be running. A change terminates a running app on iOS, a revoke one
   * on Android, so it goes before the `app.open()` a test starts with.
   */
  setPermission(permission: DevicePermission, state: PermissionState): Promise<void>;
  /**
   * Sets the simulated location, switching location services on first on
   * Android. A latitude outside -90 to 90, a longitude outside -180 to 180,
   * or either one not a finite number is `INVALID_ARGUMENT`, before any
   * device command.
   */
  setLocation(coordinates: { latitude: number; longitude: number }): Promise<void>;
  /** Turns simulated location off; on Android that is location services off, until the next `setLocation`. */
  clearLocation(): Promise<void>;
  /** Sets the system appearance. */
  setAppearance(mode: 'light' | 'dark'): Promise<void>;
  /** Rotates the device. */
  setOrientation(orientation: DeviceOrientation): Promise<void>;
  /** Reads the screen size in the coordinate space of screen taps. */
  viewport(): Promise<ViewportSize>;
  /**
   * Puts a foldable simulator or emulator in a hinge pose. On the iPhone Duo
   * it resolves once agent-device reads the angle back from CoreDevice at
   * that pose, typically 10 to 16 seconds later; `closed` lights the outer
   * display, `half-open` (a 130° book) and `open` light the inner one. On a
   * foldable Android emulator it sets the emulator console posture and
   * resolves once the guest commits the matching device state, within a few
   * seconds; `half-open` is the profile's own angle there (90° on the Pixel
   * folds), and a fold to the cover display dismisses the lock screen it
   * raises. Either way the app window changes size, so the next observation
   * reads a new screen. Any device without a hinge is `UNSUPPORTED_CAPABILITY`.
   */
  fold(pose: FoldPose): Promise<void>;
  /**
   * Simulates one biometric attempt on the open app. `faceid` and `touchid`
   * work on an iOS simulator; `fingerprint` works on an Android emulator and
   * on a phone that exposes `cmd fingerprint`. Any other pair is
   * `UNSUPPORTED_CAPABILITY`. An Android app's prompt reads the touch
   * only once the device has a screen lock and an enrolled fingerprint,
   * which `enrollBiometrics` cannot set up.
   */
  setBiometrics(sensor: BiometricSensor, result: 'match' | 'nonmatch'): Promise<void>;
  /**
   * Enrolls or unenrolls the simulator's Face ID or Touch ID. On Android or a
   * physical iOS device it is `UNSUPPORTED_CAPABILITY`.
   */
  enrollBiometrics(sensor: 'faceid' | 'touchid', enrolled: boolean): Promise<void>;
  /**
   * Installs a build (an iOS `.app` bundle or an Android `.apk`, resolved
   * against the project root) on the device; without a path, the target's
   * `app.appPath`. The engine installs nothing on its own, so a suite that runs
   * against a build calls this once per device, in a fixture or a test.
   * `reinstall: true` removes the app first so it starts with no data; a
   * plain install replaces the binary and keeps its data. Resolves to the
   * identity to `openApp` it by, which becomes the app `app.open()` launches
   * when the target's build is installed and no `app.bundleId` is pinned.
   */
  installApp(appPath?: string, options?: InstallAppOptions): Promise<InstalledApp>;
  /**
   * Removes an app, by bundle id or package, from the device; without one,
   * the pinned app. Resolves to whether it was installed, so removing an app
   * id that is not there passes. Without `app.bundleId` on the target,
   * removing the build `installApp` pinned unpins it: `app.open()` then
   * needs another install.
   */
  uninstallApp(app?: string): Promise<boolean>;
  /**
   * Whether an app, by bundle id or package, is on the device, system apps
   * included (Android: launchable apps only); without one, the pinned app.
   */
  isAppInstalled(app?: string): Promise<boolean>;
  /**
   * Brings an app to the foreground; `relaunch` restarts it fresh.
   * `launchArguments` and `permissions` apply to this launch alone; the
   * target's `app.launchArguments` and `app.permissions` apply to a
   * `relaunch` of the pinned app, and to no foreground-only open.
   */
  openApp(app: string, options?: OpenAppOptions): Promise<void>;
  /**
   * Opens a deep link (`myapp://orders/42`) or a web link (`https://...`)
   * into `app` (default: the pinned app), which the session observes
   * afterwards. iOS launches the app for a web link and then opens the URL;
   * a web link the app does not claim goes to Safari, and the next
   * observation brings the app back. Android starts the link on that
   * package. Without an app, Android lets the OS route the link; iOS needs
   * one (`INVALID_ARGUMENT` without). `file:`, `data:`, `javascript:`,
   * `view-source:`, `blob:`, and `filesystem:` links are `POLICY_DENIED`.
   */
  openLink(url: string, options?: { app?: string }): Promise<void>;
  /**
   * Terminates the session's app and ends the session, so the next
   * `openApp` launches it fresh. Until then the screen is unobservable and
   * `foregroundApp` is `APP_NOT_OPEN`.
   */
  closeApp(): Promise<void>;
  /**
   * Resets the simulator's keychain, every app's, since simctl has no
   * per-app reset: what `app.clearState()` leaves behind (a session token, a
   * Firebase sign-in). iOS simulator only; Android is
   * `UNSUPPORTED_CAPABILITY`. Launch the app afterwards to see it signed out.
   */
  clearKeychain(): Promise<void>;
  /**
   * The app the session is on. iOS answers from the session, not the
   * device, so it names the app the session opened even after `home()`;
   * Android reads the device's foreground activity. `APP_NOT_OPEN` once
   * `closeApp` ended the session.
   */
  foregroundApp(): Promise<ForegroundApp>;
  /** Sends the device to its home screen. */
  home(): Promise<void>;
  /** Navigates back once (in-app back). */
  back(): Promise<void>;
  /**
   * Presses one TV remote button: the D-pad's `'up'`, `'down'`, `'left'`,
   * `'right'`, and `'select'`, `'back'`, `'menu'`, `'home'`, and the media
   * keys such as `'play-pause'`. Android TV takes every button and an Apple
   * TV the D-pad, `back`, `menu`, and `home`, where `back` and `menu` are the
   * same Siri Remote button; any other button or device is
   * `UNSUPPORTED_CAPABILITY`. A name outside the list is `INVALID_ARGUMENT`.
   */
  pressRemote(key: RemoteKey): Promise<void>;
  /**
   * Presses one hardware button: `'volume-up'`, `'volume-down'`, or
   * `'power'`. An Android emulator or phone takes all three, and a physical
   * iPhone or iPad the volume buttons; an iOS simulator, an Android TV, and
   * any other device or button is `UNSUPPORTED_CAPABILITY`. A name outside
   * the list is `INVALID_ARGUMENT`.
   * It resolves once the press is sent, with no volume level or screen state,
   * so assert on what the screen shows next.
   */
  pressButton(button: HardwareButton): Promise<void>;
  /**
   * Shakes the device once: the simulator's shake gesture on an iPhone or
   * iPad simulator, a swing of the accelerometer on an Android phone or
   * tablet emulator. `UNSUPPORTED_CAPABILITY` on a physical device and on a
   * device a provider drives through its own backend. It resolves once the
   * shake is sent, so assert on what the app shows next.
   */
  shake(): Promise<void>;
  /**
   * Locks the screen and resolves once the device reports it locked: the
   * sleep key on an Android phone or tablet, the lock button on an iPhone or
   * iPad simulator. A screen that is already locked stays locked. A lock
   * that asks for a PIN, pattern, password, or passcode is locked too, but
   * `unlock()` refuses it, so the device stays locked until someone unlocks
   * it by hand: use Swipe on Android and no passcode on iOS.
   * `UNSUPPORTED_CAPABILITY` on a device agent-device cannot lock (a physical
   * iPhone or iPad, a TV, a device a provider drives through a backend that
   * has no lock command), and on an Android device whose screen lock is set
   * to None, which has no lock screen to show. Android 11 to 15 do not
   * report that setting, so there the sleep key is sent, the display turns
   * off, and the lock fails with `ENGINE_FAILURE` after about 5 seconds.
   * Android 10 and older do not report the lock type either, so a lock or
   * an unlock that would change the state fails with `ENGINE_FAILURE`
   * before any key is sent.
   */
  lock(): Promise<void>;
  /**
   * Unlocks the screen and resolves once the device reports it unlocked.
   * Nothing brings an app to the front: check the screen you expect next.
   * Android wakes the screen and dismisses
   * the keyguard, an iOS simulator swipes up from the bottom edge. A display
   * that is off turns on even when the screen is not locked (Android always
   * sends its wake key); an unlocked screen that is on stays as it is. The
   * exception is an iPhone simulator with an always-on display, such as the
   * iPhone 17 Pro: the unlock can leave its display off, and on iOS 26.5 the
   * text a later fill types does not reach the app. It never
   * enters a PIN, pattern, password, or passcode: a lock that asks for one is
   * `UNSUPPORTED_CAPABILITY`, and so is a device agent-device cannot lock (a
   * physical iPhone or iPad, a TV, a device a provider drives through a
   * backend that has no lock command).
   */
  unlock(): Promise<void>;
  /** Accepts or dismisses the visible system alert. */
  alert(action: 'accept' | 'dismiss'): Promise<void>;
  /**
   * Dismisses the soft keyboard. Android hides it directly. iOS has no such
   * call, on an iPhone or an iPad, so there it goes the way a user sends it
   * away: a short drag that a scroll view turns into a dismissal, horizontal
   * first and vertical second, stopping as soon as the keyboard is gone. Each
   * drag starts at the point nearest the centre of the screen that no control
   * in the captured accessibility tree covers, inside a scroll view when the
   * screen has one, to avoid pressing a button or toggling a checkbox. A
   * control the tree leaves out, such as pressable text, can still be hit. The
   * simulator's "Speed up your typing" tip goes through its Continue button
   * first. A screen with no clear point above the keyboard, a keyboard reported
   * up with no frame and no keyboard element on screen (so no point is known
   * to be above it), or a keyboard that outlives both drags, fails with
   * `UNSUPPORTED_CAPABILITY`; the message names the alternatives (the app's
   * own Done or close control, or pressing Enter on the field).
   */
  dismissKeyboard(): Promise<void>;
  /**
   * Whether the soft keyboard is on screen, from a capture (taken again,
   * within the action timeout, while the keyboard is still moving): what
   * agent-device reported for it (a visibility probe, a measured or derived
   * keyboard frame, or proof that there is none), else the keyboard or a key
   * drawn on screen in the accessibility tree (the suggestion strip alone,
   * as with a hardware keyboard, is not one). Only agent-device's proof
   * answers `false`. Fails when the capture cannot answer: `ENGINE_FAILURE`
   * while the keyboard is moving or the tree is still incomplete,
   * `UNSUPPORTED_CAPABILITY` when agent-device did not prove the keyboard
   * absent and the tree lists none. It reads the screen as it is now, so
   * right after an action that opens or closes the keyboard, poll it with
   * `expect.poll`. A poll reads again after any error: an `ENGINE_FAILURE`
   * clears once the keyboard settles, while an `UNSUPPORTED_CAPABILITY`
   * that lasts (a provider that cannot read the keyboard at all) makes the
   * poll wait out its whole timeout before it fails.
   * Changes nothing on the device.
   */
  isKeyboardShown(): Promise<boolean>;
  /** Reads the clipboard. */
  clipboard(): Promise<string>;
  /** Writes the clipboard. */
  setClipboard(text: string): Promise<void>;
}

/**
 * The coordinates `device.setLocation` was given, or `INVALID_ARGUMENT`
 * naming the one out of range. agent-device refuses the same values, but as
 * a device failure.
 */
function requireCoordinates(coordinates: unknown): { latitude: number; longitude: number } {
  const given = typeof coordinates === 'object' && coordinates !== null ? (coordinates as Record<string, unknown>) : {};
  return { latitude: coordinate(given, 'latitude', 90), longitude: coordinate(given, 'longitude', 180) };
}

/** One coordinate within ±`limit`, or `INVALID_ARGUMENT` showing what was given. */
function coordinate(given: Record<string, unknown>, name: 'latitude' | 'longitude', limit: number): number {
  const value = given[name];
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit) return value;
  const shown = typeof value === 'string' ? JSON.stringify(value) : typeof value === 'object' && value !== null ? `type ${typeof value}` : String(value);
  throw new TestError('INVALID_ARGUMENT', `device.setLocation: ${name} must be a finite number from -${limit} to ${limit}, got ${shown}`);
}

/** The raw driver session a surface is bound to: `device.unstable_raw`, and what `unstable_deviceSession()` hands a custom tool. */
export function rawSession(surface: AgentDeviceSurface): DeviceSession {
  const { session, deviceId, deviceName } = surface.boundDevice;
  return {
    platform: surface.options.platform,
    session,
    deviceId,
    deviceName,
    selection: surface.selection(),
    get client() {
      return surface.requireClient();
    },
  };
}

/** Builds the device fixture for one attempt. */
export function createDeviceFixture(surface: AgentDeviceSurface, context: EngineFixtureContext): Device {
  const device: Device = {
    get unstable_raw() {
      return rawSession(surface);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector }),
    async setNetwork(state) {
      if (surface.options.platform === 'ios') {
        if (state === 'offline') throw unsupported(`device.setNetwork('offline') turns off an Android device's Wi-Fi; ${IOS_OFFLINE}`);
        return;
      }
      await surface.command(
        'device.setNetwork',
        (client) => client.settings.update({ ...surface.selection(), setting: 'wifi', state: state === 'offline' ? 'off' : 'on' }),
        context.signal,
      );
    },
    async setAirplaneMode(enabled) {
      if (surface.options.platform === 'ios') {
        if (enabled) throw unsupported(`device.setAirplaneMode(true) cuts an Android device's radios; ${IOS_OFFLINE}`);
        return;
      }
      await surface.command(
        'device.setAirplaneMode',
        (client) => client.settings.update({ ...surface.selection(), setting: 'airplane', state: enabled ? 'on' : 'off' }),
        context.signal,
      );
    },
    async setPermission(permission, state) {
      await surface.setPermission(permission, state, context.signal);
    },
    async setLocation(coordinates) {
      const { latitude, longitude } = requireCoordinates(coordinates);
      // Android reads a fix only while location services are on, and
      // `clearLocation` switched them off for good on the emulator (the
      // setting outlives the app); iOS has no such switch.
      if (surface.options.platform === 'android') {
        await surface.command(
          'device.setLocation',
          (client) => client.settings.update({ ...surface.selection(), setting: 'location', state: 'on' }),
          context.signal,
        );
      }
      await surface.command(
        'device.setLocation',
        (client) => client.settings.update({ ...surface.selection(), setting: 'location', state: 'set', latitude, longitude }),
        context.signal,
      );
    },
    async clearLocation() {
      await surface.command(
        'device.clearLocation',
        (client) => client.settings.update({ ...surface.selection(), setting: 'location', state: 'off' }),
        context.signal,
      );
    },
    async setAppearance(mode) {
      await surface.command(
        'device.setAppearance',
        (client) => client.settings.update({ ...surface.selection(), setting: 'appearance', state: mode }),
        context.signal,
      );
    },
    async setOrientation(orientation) {
      await surface.screenCommand('device.setOrientation', (client) => client.command.orientation({ ...surface.selection(), orientation }), context.signal);
    },
    async viewport() {
      const operation = context.operation();
      return surface.viewport(operation, surface.inputBudget('device.viewport', operation));
    },
    async fold(pose) {
      await surface.fold(pose, context.signal);
    },
    async setBiometrics(sensor, result) {
      await surface.command(
        'device.setBiometrics',
        (client) =>
          sensor === 'fingerprint'
            ? client.settings.update({ ...surface.selection(), setting: 'fingerprint', state: result })
            : client.settings.update({ ...surface.selection(), setting: sensor, state: result }),
        context.signal,
      );
    },
    async enrollBiometrics(sensor, enrolled) {
      await surface.command(
        'device.enrollBiometrics',
        (client) => client.settings.update({ ...surface.selection(), setting: sensor, state: enrolled ? 'enroll' : 'unenroll' }),
        context.signal,
      );
    },
    async installApp(appPath, options) {
      return surface.installApp(appPath, options ?? {}, context.signal);
    },
    async uninstallApp(app) {
      return surface.uninstallApp(app, context.signal);
    },
    async isAppInstalled(app) {
      return surface.isAppInstalled(app, context.signal);
    },
    async openApp(app, options) {
      await surface.openApp(app, options ?? {}, context.signal);
    },
    async openLink(url, options) {
      await surface.openLink(linkTarget(url), options?.app, context.signal);
    },
    async closeApp() {
      await surface.closeApp(context.signal);
    },
    async clearKeychain() {
      await surface.clearKeychain(context.signal);
    },
    async foregroundApp() {
      const state = await surface.command('device.foregroundApp', (client) => client.command.appState({}), context.signal);
      if ('package' in state) return { name: state.package, bundleId: state.package };
      return {
        name: state.appName,
        ...(state.appBundleId === undefined ? {} : { bundleId: state.appBundleId }),
      };
    },
    async home() {
      await surface.screenCommand('device.home', (client) => client.command.home(surface.selection()), context.signal);
    },
    async back() {
      await surface.screenCommand('device.back', (client) => client.command.back({ ...surface.settleOptions }), context.signal);
    },
    async pressRemote(key) {
      requireRemoteKey(key);
      const input = surface.inputBudget('device.pressRemote', { timeoutMs: context.timeouts.action, signal: context.signal });
      await surface.screenCommand('device.pressRemote', (client) => input.send(() => pressRemote(client, key, surface.selection())), context.signal);
    },
    async pressButton(button) {
      requireHardwareButton(button);
      const input = surface.inputBudget('device.pressButton', { timeoutMs: context.timeouts.action, signal: context.signal });
      await surface.screenCommand('device.pressButton', (client) => input.send((signal) => pressButton(client, button, surface.selection(), signal)), context.signal);
    },
    async shake() {
      await surface.screenCommand('device.shake', (client) => client.command.shake(surface.selection()), context.signal);
    },
    async lock() {
      await surface.screenCommand('device.lock', (client) => client.command.lockScreen({ ...surface.selection(), action: 'lock' }), context.signal);
    },
    async unlock() {
      await surface.screenCommand('device.unlock', (client) => client.command.lockScreen({ ...surface.selection(), action: 'unlock' }), context.signal);
    },
    async alert(action) {
      await surface.screenCommand('device.alert', (client) => client.command.alert({ ...surface.selection(), action }), context.signal);
    },
    async dismissKeyboard() {
      await surface.dismissKeyboard(context.signal, surface.inputBudget('device.dismissKeyboard', { timeoutMs: context.timeouts.action, signal: context.signal }));
    },
    async isKeyboardShown() {
      return surface.keyboardShown(context.signal, surface.inputBudget('device.isKeyboardShown', { timeoutMs: context.timeouts.action, signal: context.signal }));
    },
    async clipboard() {
      const result = await surface.command(
        'device.clipboard',
        (client) => client.command.clipboard({ ...surface.selection(), action: 'read' }),
        context.signal,
      );
      return result.action === 'read' ? result.text : '';
    },
    async setClipboard(text) {
      await surface.command('device.setClipboard', (client) => client.command.clipboard({ ...surface.selection(), action: 'write', text }), context.signal);
    },
  };
  const action = { kind: 'resource' } as const;
  return context.fixture('device', device, {
    setNetwork: { ...action, label: (state) => state },
    setAirplaneMode: action,
    setPermission: { ...action, label: (permission) => permission },
    setLocation: action,
    clearLocation: action,
    setAppearance: { ...action, label: (mode) => mode },
    setOrientation: { ...action, label: (orientation) => orientation },
    viewport: action,
    fold: { ...action, label: (pose) => pose },
    setBiometrics: action,
    enrollBiometrics: action,
    installApp: { ...action, label: (appPath) => appPath ?? surface.appPath ?? 'appPath' },
    uninstallApp: { ...action, label: (app) => appLabel(app ?? surface.pinnedApp ?? 'app') },
    isAppInstalled: { ...action, label: (app) => appLabel(app ?? surface.pinnedApp ?? 'app') },
    openApp: { ...action, label: (app) => appLabel(app) },
    openLink: { ...action, label: (url) => linkLabel(url) },
    closeApp: action,
    clearKeychain: action,
    foregroundApp: action,
    home: action,
    back: action,
    pressRemote: { ...action, label: (key) => key },
    // A JavaScript caller can pass a key code; the label must still be text, so the step records the refusal.
    pressButton: { ...action, label: (button) => String(button) },
    shake: action,
    lock: action,
    unlock: action,
    alert: { ...action, label: (value) => value },
    dismissKeyboard: action,
    isKeyboardShown: action,
    clipboard: action,
    setClipboard: { ...action, label: (text) => `${text.length} chars` },
  });
}
