/**
 * The Playwright engine for e2e: a browser body built with the
 * public `defineEngine`, validated by the same rules and graded by the same
 * capabilities as any other engine. Core imports nothing from here; this
 * package imports the contract from `@e2e-dev/core/engine` and contributes the `browser`
 * fixture the way a device engine contributes `device`.
 */

import type { BrowserContext, Page } from 'playwright-core';
import {
  ConfigurationError,
  defineEngine,
  isSecret,
  LOCATOR_ACTION_KINDS,
  POINTER_ACTION_KINDS,
  rejectUnknownKeys,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
  type EngineIsolation,
} from '@e2e-dev/core/engine';
import { createRequire } from 'node:module';
import type { WebFixtures } from './fixtures.ts';
import { asBrowserProvider, type BrowserProvider } from './provider.ts';
import { PlaywrightSurface, type WebOptions } from './surface.ts';
import { createBrowserFixture } from './browser.ts';
import { validateInitScripts } from './init-scripts.ts';
import { MEDIA_KEYS, mediaProblem } from './media.ts';
import { FIELD_VALUE_CONTROL, headerProblem, originProblem } from './protected-app.ts';
import { validatePermissions } from './permissions.ts';
import { BROWSER_NAMES, isBrowserName } from './browser-connection.ts';

/** App fields only a device target reads. */
const NATIVE_APP_KEYS = ['bundleId', 'appPath', 'launchArguments'] as const;

/** Creates one Playwright engine: one browser per worker, one context per attempt. */
const surfaces = new WeakMap<EngineHandle, PlaywrightSurface>();

/**
 * The live browser objects behind a `web()` handle, for agent-side code
 * that replaces the toolset wholesale (spec chapter 16) and drives the page with
 * its own Playwright tooling. Both accessors read the current attempt: the
 * context exists from `startAttempt`, the page from the first `app.open()` or
 * `browser.goto()`, and either throws `INVALID_STATE` before that. The harness
 * remains the notary for what it witnesses; a caller here acts out of band.
 */
export interface PlaywrightLiveSurface {
  readonly page: () => Page;
  readonly context: () => BrowserContext;
}

/** The live surface of a handle this module created, or undefined for any other engine. */
export function surfaceOf(engine: EngineHandle): PlaywrightLiveSurface | undefined {
  const surface = surfaces.get(engine);
  if (surface === undefined) return undefined;
  return { page: () => surface.requirePage(), context: () => surface.requireContext() };
}

/**
 * The handle `web()` returns. Declared here so a config's inferred type
 * names this package: a project sees `@e2e-dev/core` only through its
 * dependencies, and TypeScript cannot write that path in a declaration.
 */
export interface WebEngine<Platform extends string = string, Isolation extends EngineIsolation = EngineIsolation>
  extends EngineHandle<WebFixtures, Platform, Isolation> {}

export function web(options: WebOptions = {}): WebEngine<'web', 'attempt'> {
  if ('allowedOrigins' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'web({ allowedOrigins }) is gone: navigation and secret fills are not gated by origin; remove the option',
    );
  }
  if ('video' in options) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      "web({ video }) was renamed web({ screencast }): it takes { size?, quality? } for the page screencast; which attempts record is the video mode on the config or a target",
    );
  }
  rejectUnknownKeys('web()', options, WEB_OPTION_KEYS);
  const provider = resolveBrowser(options.browser);
  if (provider !== undefined && options.connect !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ browser, connect }) names two browser sources; browser provider "${provider.name}" leases its own browsers, so remove connect`,
    );
  }
  if (options.connect !== undefined) validateConnect(options.connect);
  if (options.connect !== undefined && typeof options.browser === 'string' && options.browser !== 'chromium') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect }) requires the chromium browser; CDP attach is chromium-only, got "${options.browser}"`,
    );
  }
  if (options.headers !== undefined) validateHeaders(options.headers);
  if (options.basicAuth !== undefined) validateBasicAuth(options.basicAuth);
  if (options.credentialOrigins !== undefined) validateCredentialOrigins(options);
  if (options.testIdAttribute !== undefined) validateTestIdAttribute(options.testIdAttribute);
  if (options.chromiumSandbox !== undefined) validateChromiumSandbox(options.chromiumSandbox);
  if (options.userAgent !== undefined) validateUserAgent(options.userAgent, options.headers);
  if (options.locale !== undefined) validateLocale(options.locale, options.headers);
  if (options.timezoneId !== undefined) validateTimezoneId(options.timezoneId);
  validateMedia(options);
  if (options.initScripts !== undefined) validateInitScripts(options.initScripts);
  if (options.viewport !== undefined && options.viewport !== null) validatePixelSize('web({ viewport })', options.viewport);
  if (options.deviceScaleFactor !== undefined) validateDeviceScaleFactor(options);
  if (options.screencast !== undefined) validateScreencast(options.screencast);
  if (options.webmcp !== undefined) validateWebmcp(options, provider);
  const reconnecting = options.connect?.reconnectEndpoint !== undefined;
  // A per-attempt lease rides the same persistent context as `reconnectEndpoint`, with the same limits.
  const recoverable = reconnecting || provider?.scope === 'attempt';
  const mode = provider === undefined ? 'connect.reconnectEndpoint' : `browser provider "${provider.name}" with scope "attempt"`;
  const creationOptions = CREATION_OPTION_KEYS.filter((key) => options[key] !== undefined);
  if (recoverable && creationOptions.length > 0) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${mode} uses a persistent context; ${creationOptions.join(', ')} ${creationOptions.length === 1 ? 'requires' : 'require'} a newly created context`,
    );
  }
  const surface = new PlaywrightSurface(options);
  const handle = defineEngine<WebFixtures, 'web', 'attempt'>({
    name: 'web',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'web',
    fileApps: true,
    prepare: (info) => surface.prepare(info),
    finish: (info) => surface.finish(info),
    doctor: (info) => surface.doctor(info),
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    settleAttempt: (context) => surface.settleAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, observeOptions) => surface.observe(operation, observeOptions),
    readStyle: (ref, properties, operation) => surface.readStyle(ref, properties, operation),
    viewportIntersection: (ref, operation) => surface.viewportIntersection(ref, operation),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    // A browser honors the SPI v1 actions plus blur, in-memory uploads, and multi-taps; `actions.ts` dispatches each.
    actions: [...LOCATOR_ACTION_KINDS, 'blur', 'setInputFilePayloads', 'multiTap'],
    // Playwright holds each modifier for the click.
    tapModifiers: true,
    // A page takes every pointer action of the contract at a bare point too.
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: POINTER_ACTION_KINDS,
    keyboard: {
      type: (text, keyboardOptions, operation) => surface.typeText(text, keyboardOptions, operation),
      press: (key, operation) => surface.pressKey(key, operation),
    },
    // `app.permissions: 'all'` grants every name the browser takes; see grantPermissions.
    grantsAllPermissions: true,
    // A provider or a CDP attach speaks CDP, so it takes Chromium's names.
    validateApp: (app, info) => validateApp(app, info, options),
    ...(isSecret(options.basicAuth?.password) ? { secrets: [options.basicAuth.password] } : {}),
    session: {
      open: (url, operation) => surface.open(url, operation),
      back: (operation) => surface.back(operation),
      resize: (size, operation) => surface.resize(size, operation),
      switchTab: (index, operation) => surface.switchTab(index, operation),
      closeTab: (index, operation) => surface.closeTabAt(index, operation),
      restart: (operation) => surface.restart(operation),
      reset: recoverable ? () => Promise.reject(persistentContextLimit('app.clearState()', mode, provider !== undefined)) : (operation) => surface.reset(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
      startVideo: (operation) => surface.startVideo(operation),
      stopVideo: (operation) => surface.stopVideo(operation),
    },
    ...(recoverable
      ? {}
      : {
          state: {
            capture: (operation) => surface.captureState(operation),
            restore: (state, operation) => surface.restoreState(state, operation),
          },
        }),
    fixtures: {
      browser: (context) => createBrowserFixture(surface, context),
    },
  });
  surfaces.set(handle, surface);
  return handle;
}

/** Every option `web()` takes, kept equal to `WebOptions` by the compiler. */
const WEB_OPTION_KEYS: readonly string[] = Object.keys({
  browser: true,
  chromiumSandbox: true,
  viewport: true,
  deviceScaleFactor: true,
  screencast: true,
  connect: true,
  headers: true,
  basicAuth: true,
  credentialOrigins: true,
  testIdAttribute: true,
  userAgent: true,
  locale: true,
  timezoneId: true,
  colorScheme: true,
  reducedMotion: true,
  initScripts: true,
  webmcp: true,
} satisfies Record<keyof WebOptions, true>);

/** The options applied when the engine creates a browser context, which a persistent context never is. */
const CREATION_OPTION_KEYS = ['headers', 'basicAuth', 'userAgent', 'locale', 'timezoneId', 'deviceScaleFactor'] as const satisfies readonly (keyof WebOptions)[];

/**
 * What a persistent context rules out, named with its cause: `what` replaces
 * the browser context, which `mode` never does. A per-attempt lease starts
 * every attempt on a fresh browser already, and worker scope has the reset.
 */
function persistentContextLimit(what: string, mode: string, leased: boolean): ConfigurationError {
  const remedy = leased ? '; every attempt already starts on a fresh browser, and scope "worker" can clear one mid-test' : '';
  return new ConfigurationError(
    'UNSUPPORTED_CAPABILITY',
    `${what} is unavailable with ${mode}: it replaces the browser context, and the attempt rides one persistent context${remedy}`,
  );
}

/** True for a plain object; the shape both options take. Config runs as JavaScript, so the types alone are no guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Names a value's kind for a config error without echoing it: a CDP URL can carry a session token. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  return type === 'object' ? 'an object' : `a ${type}`;
}

/**
 * `cdpEndpoint` is the one resolver every connect mode needs: the shared
 * browser's source at init, and the fresh browser each persistent attempt
 * provisions. Without it the attach would call an undefined resolver, so a
 * config missing it fails here, at load, instead of at worker init or on
 * every attempt with `ENGINE_FAILURE: ... resolve is not a function`.
 */
function validateConnect(connect: unknown): void {
  if (!isRecord(connect)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect }) must be a plain object: { cdpEndpoint, reconnectEndpoint? }, got ${kindOf(connect)}`);
  }
  rejectUnknownKeys('web({ connect })', connect, ['cdpEndpoint', 'reconnectEndpoint']);
  const { cdpEndpoint, reconnectEndpoint } = connect;
  if (cdpEndpoint === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ connect }) requires cdpEndpoint, the resolver that provisions the browser: (signal) => url${
        reconnectEndpoint === undefined ? '' : '; reconnectEndpoint only reconnects to the browser cdpEndpoint provisioned'
      }`,
    );
  }
  if (typeof cdpEndpoint !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect: { cdpEndpoint } }) must be a resolver function (signal) => url, got ${kindOf(cdpEndpoint)}`);
  }
  if (reconnectEndpoint !== undefined && typeof reconnectEndpoint !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `web({ connect: { reconnectEndpoint } }) must be a resolver function (signal) => url, got ${kindOf(reconnectEndpoint)}`);
  }
}

/**
 * Refuses a header the browser could not send, at config load rather than at
 * the first request: a name outside the token grammar, a value carrying a
 * control character (a line break is a header-injection vector), or a value
 * that is not a string at all.
 */
function validateHeaders(headers: unknown): void {
  if (!isRecord(headers)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ headers }) must be an object of header name to value');
  }
  for (const [name, value] of Object.entries(headers)) {
    const problem = headerProblem(name, value);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ headers }) ${problem}`);
  }
}

/** Refuses credentials the browser could not present: a missing field, or a `:` in the user name (RFC 7617). */
function validateBasicAuth(basicAuth: unknown): void {
  if (!isRecord(basicAuth)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) must be an object with username and password');
  }
  rejectUnknownKeys('web({ basicAuth })', basicAuth, ['username', 'password']);
  const { username, password } = basicAuth;
  if (typeof username !== 'string' || username === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a non-empty username string');
  }
  if (username.includes(':')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) username must not contain ":"');
  }
  if (typeof password !== 'string' && !isSecret(password)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ basicAuth }) requires a password string or secrets.get(name)');
  }
}

/**
 * Refuses extra credential origins without headers or basic auth to send
 * them, a list that is not an array, and any entry that is not an exact
 * `http:` or `https:` origin, naming the entry.
 */
function validateCredentialOrigins({ credentialOrigins, headers, basicAuth }: WebOptions): void {
  if (headers === undefined && basicAuth === undefined) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ credentialOrigins }) requires headers or basicAuth: it lists more origins that receive them');
  }
  if (!Array.isArray(credentialOrigins)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ credentialOrigins }) must be an array of origins such as "https://preview.example.com"');
  }
  for (const [index, origin] of credentialOrigins.entries()) {
    const problem = originProblem(origin);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', `web({ credentialOrigins })[${index}] ${problem}`);
  }
}

/**
 * Refuses a user agent the browser could not send (not a string, empty, or
 * carrying a control character) and one a `user-agent` header would override
 * on the app's origin while `navigator.userAgent` kept reporting it.
 */
function validateUserAgent(userAgent: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof userAgent !== 'string' || userAgent === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must be a non-empty string');
  }
  if (FIELD_VALUE_CONTROL.test(userAgent)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) must not contain a control character');
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ userAgent }) and a user-agent header in web({ headers }) conflict; set userAgent only');
  }
}

/**
 * Refuses a locale that is not a BCP 47 tag, and one an `accept-language`
 * header would override on the app's origin while `navigator.language` kept
 * reporting it.
 */
function validateLocale(locale: unknown, headers: Readonly<Record<string, string>> | undefined): void {
  if (typeof locale !== 'string' || locale === '' || !isLanguageTag(locale)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ locale }) must be a BCP 47 language tag such as "de-DE", got ${JSON.stringify(locale)}`);
  }
  if (headers !== undefined && Object.keys(headers).some((name) => name.toLowerCase() === 'accept-language')) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ locale }) and an accept-language header in web({ headers }) conflict; set locale only');
  }
}

/**
 * True when `tag` names a language the browser can run in: a Unicode locale
 * `Intl.Locale` parses, other than the undetermined `und`, which Chromium
 * refuses at context creation as it does a private-use-only tag.
 */
function isLanguageTag(tag: string): boolean {
  try {
    const { language } = new Intl.Locale(tag);
    return language !== undefined && language !== 'und';
  } catch {
    return false;
  }
}

/**
 * Refuses, at config load, a time zone the browser would otherwise refuse at
 * the first context. Best effort: Node cannot tell a miscased alias
 * (`us/eastern`) from the real one, so the browser's own `Invalid timezone ID`
 * stays the final word.
 */
function validateTimezoneId(timezoneId: unknown): void {
  if (typeof timezoneId !== 'string' || timezoneId === '' || !isTimeZone(timezoneId)) {
    throw new ConfigurationError('INVALID_CONFIG', `web({ timezoneId }) must be an IANA time zone such as "Europe/Berlin", got ${JSON.stringify(timezoneId)}`);
  }
}

/**
 * `webmcp` changes how the browser is launched, so it needs a browser the
 * engine launches, and one that has WebMCP: WebKit does not.
 */
function validateWebmcp(options: WebOptions, provider: BrowserProvider | undefined): void {
  if (typeof options.webmcp !== 'boolean') {
    throw new ConfigurationError('INVALID_CONFIG', `web({ webmcp }) must be true or false, got ${JSON.stringify(options.webmcp)}`);
  }
  if (!options.webmcp) return;
  const elsewhere = provider !== undefined ? `browser provider "${provider.name}"` : options.connect !== undefined ? 'connect' : undefined;
  if (elsewhere !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ webmcp }) is a launch setting, and with ${elsewhere} the engine does not launch the browser; start that browser with --enable-features=WebMCP and remove webmcp`,
    );
  }
  if (options.browser === 'webkit') {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ webmcp }) requires the chromium or firefox browser; WebKit does not implement WebMCP');
  }
}

/**
 * Refuses a media feature value the browser does not emulate, at config load
 * rather than at the first page. A persistent context takes these too: they
 * are set on each page, not only on a context the engine creates.
 */
function validateMedia(options: WebOptions): void {
  for (const key of MEDIA_KEYS) {
    const problem = mediaProblem((name) => `web({ ${name} })`, key, options[key]);
    if (problem !== undefined) throw new ConfigurationError('INVALID_CONFIG', problem);
  }
}

/**
 * True when `timeZone` is an IANA name `Intl` resolves, spelled with its own
 * case. Node also takes an offset (`+01:00`) and any casing (`europe/berlin`),
 * both of which Chromium refuses; an alias resolving to another name
 * (`US/Eastern`) is fine.
 */
function isTimeZone(timeZone: string): boolean {
  if (/^[+-]/.test(timeZone)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
    return resolved === timeZone || resolved.toLowerCase() !== timeZone.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * An attribute name the document grammar accepts (XML `Name`, ASCII): a value
 * outside it could never be on an element, so `getByTestId` would match nothing
 * and every `testId` query would fail silently.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;

/** `web({ browser })`: undefined for a name the engine launches or no browser, the checked provider for an object, and a refusal for anything else. `browserType` reads any other string as Chromium. */
function resolveBrowser(browser: unknown): BrowserProvider | undefined {
  if (browser === undefined || (typeof browser === 'string' && isBrowserName(browser))) return undefined;
  if (isRecord(browser)) return asBrowserProvider(browser);
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `web({ browser }) must be one of ${BROWSER_NAMES.join(', ')}, or a browser provider, got ${typeof browser === 'string' ? JSON.stringify(browser) : kindOf(browser)}`,
  );
}

/** A `{ width, height }` size in whole pixels, each at least 1, with no other key; `option` names it in the message. */
function validatePixelSize(option: string, size: unknown): void {
  const fields = isPlainObject(size) ? size : {};
  const { width, height } = fields as { width?: unknown; height?: unknown };
  const unknownKey = Object.keys(fields).find((key) => key !== 'width' && key !== 'height');
  if (unknownKey !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${option} has unknown key "${unknownKey}"; it is { width, height }`);
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1) {
    throw new ConfigurationError('INVALID_CONFIG', `${option} must be { width, height } in whole pixels, each at least 1`);
  }
}

/** `web({ deviceScaleFactor })`: a number above 0, beside a viewport size the browser can scale. */
function validateDeviceScaleFactor(options: WebOptions): void {
  const factor: unknown = options.deviceScaleFactor;
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ deviceScaleFactor }) must be a number above 0');
  }
  if (options.viewport === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ deviceScaleFactor }) needs a viewport size; viewport: null leaves the window at its own scale');
  }
}

/** `web({ screencast })`: a whole-pixel frame size and a 0-100 JPEG quality, each optional. */
function validateScreencast(screencast: unknown): void {
  if (!isPlainObject(screencast)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast }) must be a plain object: { size?, quality? }');
  }
  for (const key of Object.keys(screencast as object)) {
    if (key !== 'size' && key !== 'quality') {
      throw new ConfigurationError('INVALID_CONFIG', `web({ screencast }) has unknown key "${key}"; it is { size?, quality? }, and which attempts record is the config's video`);
    }
  }
  const { size, quality } = screencast as { size?: unknown; quality?: unknown };
  if (size !== undefined) validatePixelSize('web({ screencast: { size } })', size);
  if (quality !== undefined && (!Number.isInteger(quality) || (quality as number) < 0 || (quality as number) > 100)) {
    throw new ConfigurationError('INVALID_CONFIG', 'web({ screencast: { quality } }) must be an integer from 0 through 100');
  }
}

/** An object literal (or `Object.create(null)`): not an array, a class instance, or a primitive. */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Refuses a test-id attribute no element could carry, at config load. */
function validateTestIdAttribute(attribute: unknown): void {
  if (typeof attribute !== 'string' || !ATTRIBUTE_NAME.test(attribute)) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ testIdAttribute }) must be an attribute name such as "data-testid", got ${JSON.stringify(attribute)}`,
    );
  }
}

/** Refuses a sandbox opt-out that is not a boolean, at config load. */
function validateChromiumSandbox(chromiumSandbox: unknown): void {
  if (typeof chromiumSandbox !== 'boolean') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `web({ chromiumSandbox }) must be a boolean, got ${JSON.stringify(chromiumSandbox)}`,
    );
  }
}

/**
 * A browser target opens a URL: without `app.url` there is nothing for
 * `app.open()` to open, and the fields that describe an installed device app
 * have nothing to act on here. `permissions` must be ones `browser` grants.
 */
function validateApp(app: EngineAppDeclaration, { targetName, fileApp }: EngineAppCheckInfo, options: WebOptions): void {
  for (const key of NATIVE_APP_KEYS) {
    if (app[key] !== undefined) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `target "${targetName}" declares app.${key}, which describes an installed device app; a web() target opens app.url`,
      );
    }
  }
  if (app.url === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `target "${targetName}" needs app.url: web() opens the app at a URL, such as app: { url: 'http://localhost:3000' }`,
    );
  }
  if (fileApp === true) validateFileApp(targetName, options);
  if (app.permissions !== undefined) validatePermissions(targetName, typeof options.browser === 'string' ? options.browser : 'chromium', app.permissions);
}

/**
 * A file app is read by the browser, off the disk of the machine it runs on,
 * and the harness checks every file navigation against its own disk. So the
 * browser has to be one this engine launches here: a provider's runs
 * elsewhere, and `connect` attaches to one that may. A file has no origin
 * either, and `headers` and `basicAuth` always go to the app's.
 */
function validateFileApp(targetName: string, options: WebOptions): void {
  const where = `target "${targetName}" opens a file app.url`;
  if (typeof options.browser === 'object') {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where}, which browser provider "${options.browser.name}" cannot read: its browsers run on another machine; serve the app over http(s), or launch the browser locally`,
    );
  }
  if (options.connect !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where}, and web({ connect }) attaches to a browser that may run on another machine, with another disk; serve the app over http(s), or let the engine launch the browser`,
    );
  }
  const credential = options.headers !== undefined ? 'headers' : options.basicAuth !== undefined ? 'basicAuth' : undefined;
  if (credential !== undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where}, and web({ ${credential} }) always goes to the app's origin, which a file does not have; remove the option, or serve the app over http(s)`,
    );
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
