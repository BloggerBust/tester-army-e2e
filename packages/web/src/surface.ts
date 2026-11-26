/**
 * The Playwright surface: one browser per worker, one browser context per
 * attempt, and the page every engine member delegates to. This is the closure
 * state behind `web()`; the engine hooks in `engine.ts` and the `browser`
 * fixture in `browser.ts` are thin delegates onto it. Action dispatch lives in
 * `actions.ts` and tree capture in `observation.ts`. `AttemptSession` owns
 * the attempt's live binding, recovery, references, and recordings.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, ElementHandle, Frame, FrameLocator, Locator, Page, Request, Route } from 'playwright-core';
import {
  ConfigurationError,
  Deadline,
  EngineError,
  obj,
  raceAbort,
  TestError,
  withinCleanupBudget,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineDoctorCheck,
  type EngineDoctorInfo,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EnginePrepareInfo,
  type EnginePrepareResult,
  type EngineFinishInfo,
  type EngineSnapshot,
  type EngineState,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ComputedStyleProperty,
  type ComputedStyleValues,
  validateComputedStyleProperties,
  type OperationContext,
  type PointerAction,
  type Secret,
  type SemanticNode,
  type VideoSegment,
  type ViewportIntersection,
  type ViewportPoint,
  type ViewportSize,
} from '@e2e-dev/core/engine';
import { matchesText } from '@e2e-dev/core/engine';
import { classifyActionError, classifyInputError, dispatchLocatorAction, dispatchPointerAction } from './actions.ts';
import { BrowserConnection, connectCdp, defaultChromiumSandbox, isBrowserName, type BrowserLaunchOptions, type BrowserName } from './browser-connection.ts';
import { grantedPermissions, grantPermissions } from './permissions.ts';
import { pressCharacter, pressCharacterOn, requireCharacterPress } from './press-character.ts';
import { AttemptSession, type AttemptTab, type StorageState } from './attempt-session.ts';
import type { CdpEndpointResolver } from './cdp-recovery.ts';
import { webmcpLaunch } from './webmcp.ts';
import { LeasedBrowsers, type BrowserProvider, type LeaseDownloads } from './provider.ts';
import { installAppLog } from './app-log.ts';
import { TraceFeed } from './trace-feed.ts';
import { DialogRouter } from './dialogs.ts';
import { missingLibrariesMessage } from './host-libraries.ts';
import { browserCheck, ensureBrowsersInstalled, missingBrowserLibraries } from './install.ts';
import { applyPostSteps, frameSelectors, projectExpression } from './locators.ts';
import { contentBox, frameContentInset, placeBoxInFrame, ROOT_NODE_ID, toSemanticNode } from './observation.ts';
import { captureObservation } from './observation-capture.ts';
import { maskOptions, secureFieldMasks } from './observe.ts';
import { SHOWN_SELECTOR } from './shown-selector.ts';
import { withHiddenCaret } from './screenshot-caret.ts';
import { withOperationDeadline, type OperationBound } from './operation-budget.ts';
import { CLOSED_SHADOW_ROOTS_INIT_SCRIPT, CLOSED_SHADOW_ROOTS_KEY } from './closed-shadow.ts';
import { MODAL_ORDER_INIT_SCRIPT } from './modal-dialogs.ts';
import { ConfiguredInitScripts, type WebInitScript } from './init-scripts.ts';
import type { WebMedia } from './media.ts';
import { applyClockCall, readClockNow, type ClockCall, type ClockHost } from './clock.ts';
import { SECURE_FIELD_SELECTOR, type RawNodeData } from './read-node.ts';
import { readSelector, takeReadsFunction } from './read-selector.ts';
import { credentialOrigins, httpCredentials, installConfiguredHeaders, lowercaseNames, configuredHeadersFor } from './protected-app.ts';
import { RefRegistry } from './refs.ts';
import {
  cancelled,
  DEFAULT_VIEWPORT,
  dispatchedInput,
  ErrorLatch,
  invalidState,
  isClassified,
  isNavigationRace,
  isPwTimeout,
  message,
  navigationStaleOr,
  performViewportSwipe,
  sanitizeFilename,
  pageScriptFailure,
  staleOr,
  translatePwError,
} from './support.ts';

/** Browser launch budget when the harness init budget is not otherwise expressed. */
const BROWSER_LAUNCH_TIMEOUT_MS = 60_000;

const STATE_FORMAT = 'playwright-storage-state';

/** Default budget Playwright applies to context operations that carry no explicit timeout. */
const CONTEXT_DEFAULT_TIMEOUT_MS = 30_000;

type RoutePredicate = (url: URL) => boolean;
type RouteHandler = (route: Route) => Promise<void>;

interface StoredRoute {
  readonly predicate: RoutePredicate;
  readonly handler: RouteHandler;
}

/** True for the storage-state object shape; a string (a file path) or anything else is refused. */
function isStorageState(data: unknown): data is StorageState {
  return (
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { cookies?: unknown }).cookies) &&
    Array.isArray((data as { origins?: unknown }).origins)
  );
}

/**
 * Attach to a remote browser over CDP instead of launching a local one. The
 * seam a hosted-browser engine plugs into: a per-run cloud session (its
 * endpoint provisioned only once the run starts) resolves through
 * `cdpEndpoint` at `init`, and again at an attempt start after a disconnect.
 * Supplying `reconnectEndpoint` opts into a persistent context instead.
 * CDP attach is chromium-only.
 */
export interface WebConnectOptions {
  /**
   * Resolves the CDP endpoint (a `ws://`/`wss://` or `http://` DevTools URL)
   * to attach to. Async because a hosted endpoint is not known at config load;
   * called once per worker in `init`, and again at the start of any attempt
   * that finds the session dropped, so a fresh per-run URL reconnects cleanly.
   * With `reconnectEndpoint`, init defers provisioning and every attempt
   * calls this resolver for a fresh, dedicated browser instead.
   * `signal` aborts when the init or attempt that needs the browser is
   * cancelled or exceeds its budget: a resolver that provisions a session
   * should stop and release it, since a browser that arrives late is detached.
   */
  readonly cdpEndpoint: CdpEndpointResolver;
  /**
   * Opts into a dedicated persistent remote context. `cdpEndpoint` provisions
   * a fresh browser at each attempt start; this resolver reconnects to that
   * same browser after a transport drop. Called once before the next
   * operation, within its budget. The original browser and page must survive.
   * Dispatched operations are never retried. The host owns browser cleanup.
   * Context replacement, headers, basicAuth, userAgent, locale, timezoneId, and deviceScaleFactor are unavailable in this mode.
   */
  readonly reconnectEndpoint?: CdpEndpointResolver;
}

/** HTTP basic authentication the browser answers a `401` challenge from the app's origin with. */
export interface WebBasicAuth {
  /** The user name; `:` is not allowed in one (RFC 7617). */
  readonly username: string;
  /**
   * The password, or `secrets.get(name)` for one in `config.secrets`: resolved
   * when each attempt starts and redacted from reports, logs, and observations
   * like any configured secret.
   */
  readonly password: string | Secret;
}

/** The engine's screencast of the page: the frame size and the JPEG quality of the frames it encodes. */
export interface WebScreencastOptions {
  /** Frame size in pixels; default the viewport's, or the window's under `viewport: null`. A smaller size makes a smaller file. */
  readonly size?: ViewportSize;
  /** JPEG quality of each captured frame, 0 through 100; Playwright's default when unset. */
  readonly quality?: number;
}

/** One entry of an attempt's document setup: an init script, or a clock call. */
type DocumentSetup = { readonly script: string } | { readonly clock: ClockCall };

/**
 * Options of the browser engine: how it drives the app. The app itself
 * (its `url`, `environment`, `identity`, and the command that starts it) is
 * the target's `app`.
 */
export interface WebOptions {
  /**
   * Browser to launch, `chromium` by default. A `BrowserProvider` leases
   * hosted browsers instead: one per worker slot at `prepare`, or one per
   * attempt, each attached to over CDP and released when its scope ends. A
   * provider implies chromium and excludes `connect`.
   */
  readonly browser?: BrowserName | BrowserProvider;
  /**
   * Whether a locally launched Chromium runs with its OS sandbox on; default
   * `true` on macOS and Windows, `false` on Linux.
   */
  readonly chromiumSandbox?: boolean;
  /**
   * Initial viewport of every attempt's page; default 1280 by 720. `null`
   * emulates no size: the page fills the browser window, whatever size the
   * window has (a hosted browser's live view, a headed run), and
   * `browser.setViewport` still fixes one for the rest of the attempt.
   */
  readonly viewport?: ViewportSize | null;
  /**
   * Device pixels per CSS pixel on every attempt's page, as
   * `window.devicePixelRatio` reads it; default 1. At 2 the page renders as
   * on a high-density display, and every saved screenshot
   * (`app.screenshot()`, a failure's, an `agent.assert`'s) is twice the
   * viewport's size on each side. The factor does not change the image the
   * model reads or the one `toHaveScreenshot` compares. It needs a viewport
   * size, so `viewport: null` refuses it, and a persistent context
   * (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`)
   * refuses it.
   */
  readonly deviceScaleFactor?: number;
  /**
   * How the engine's own screencast records an attempt that records video.
   * A browser provider that records (`BrowserProvider.record`) records in
   * its place, and ignores these. Which attempts record is the config's
   * `video`, not an engine option.
   */
  readonly screencast?: WebScreencastOptions;
  /**
   * Attach to a remote browser over CDP instead of launching locally. Requires
   * the chromium browser (the default). Wired by a hosted-browser engine.
   */
  readonly connect?: WebConnectOptions;
  /**
   * HTTP headers added to every request the browser starts at the app's
   * origin (`app.url`'s scheme, host, and port) or one in
   * `credentialOrigins`: a preview-protection bypass token, a tunnel's
   * interstitial skip. A request that starts at any other origin (another
   * port on the same host, a sibling subdomain, a CDN) goes without them.
   * Playwright keeps a request's headers through its redirects, so a
   * redirect from the app to an identity provider carries them there.
   * Names are case-insensitive; a header the page already
   * sends under the same name is replaced. Applies to every path onto the
   * page, deterministic and agent-driven alike. Injecting headers routes
   * every request of the attempt, which turns the browser's HTTP cache off
   * and blocks service workers (a worker's requests bypass routing, so a
   * page it controlled would reach the gate bare).
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * HTTP basic authentication for a staging app behind a browser challenge.
   * The browser answers a `401` from the app's origin, or one in
   * `credentialOrigins`, with these credentials, and no other. WebKit cannot
   * scope a credential to an origin on its scheme's default port or with an
   * IPv6 host, so when one of those origins is such an origin, WebKit
   * answers every origin's challenge. Applies to every path onto the page.
   */
  readonly basicAuth?: WebBasicAuth;
  /**
   * More origins that receive `headers` and `basicAuth`, beyond the app's
   * own: an API host or a redirect target behind the same gate. Exact
   * origins, such as `https://api.example.com`; requires `headers` or
   * `basicAuth`.
   */
  readonly credentialOrigins?: readonly string[];
  /**
   * The attribute that carries an element's test id: what the `testId` query
   * (`screen.getByTestId`) resolves and what `SemanticNode.testId` reports.
   * Defaults to `data-testid`.
   */
  readonly testIdAttribute?: string;
  /**
   * The `User-Agent` every attempt's context sends and `navigator.userAgent`
   * reports, as Playwright's own `userAgent` context option sets it: for an
   * app that switches into a test mode on a marker in the agent string.
   * Defaults to the browser's own. A `user-agent` entry in `headers` beside
   * it is `INVALID_CONFIG`, and so is a persistent context
   * (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`).
   */
  readonly userAgent?: string;
  /**
   * The locale every attempt's context runs in, a BCP 47 tag such as
   * `de-DE`, as Playwright's own `locale` context option sets it: what
   * `navigator.language`, `Intl` formatting, and the `Accept-Language` header
   * report. Defaults to the browser's own. An `accept-language` entry in
   * `headers` beside it is `INVALID_CONFIG`, and so is a persistent context
   * (`connect.reconnectEndpoint`, or a provider with `scope: 'attempt'`).
   */
  readonly locale?: string;
  /**
   * The IANA time zone every attempt's context runs in, such as
   * `Europe/Berlin`, as Playwright's own `timezoneId` context option sets it:
   * what `Date` and `Intl` resolve local time against. Defaults to the
   * machine's. A persistent context (`connect.reconnectEndpoint`, or a
   * provider with `scope: 'attempt'`) is `INVALID_CONFIG`.
   */
  readonly timezoneId?: string;
  /**
   * The `prefers-color-scheme` every page reports from its first paint, to
   * its `@media` rules and to `matchMedia`, as Playwright's own
   * `colorScheme` context option sets it. Defaults to the browser's own.
   * `browser.emulateMedia` changes it for the rest of one attempt.
   */
  readonly colorScheme?: WebMedia['colorScheme'];
  /**
   * The `prefers-reduced-motion` every page reports from its first paint, as
   * Playwright's own `reducedMotion` context option sets it: `'reduce'`
   * lets an app's own rule turn its animations off, so none races an
   * assertion. Defaults to the browser's own. `browser.emulateMedia`
   * changes it for the rest of one attempt.
   */
  readonly reducedMotion?: WebMedia['reducedMotion'];
  /**
   * Scripts every document runs before the page's own, in every tab and
   * frame: JavaScript source, a `{ path }` relative to the project root, or a
   * function, which cannot close over test variables.
   */
  readonly initScripts?: readonly WebInitScript[];
  /**
   * Launches the browser with WebMCP, the experimental browser API a page
   * registers tools through (`document.modelContext`, `navigator.modelContext`
   * on Firefox), so `browser.webmcp` can list and call them. Off by default:
   * with it the page sees an API most browsers do not have yet. Chromium and
   * Firefox, and only for a browser the engine launches; one reached through
   * `connect` or a provider has to be started with `--enable-features=WebMCP`
   * itself.
   */
  readonly webmcp?: boolean;
}

/** The test-id attribute when the options name none. */
const DEFAULT_TEST_ID_ATTRIBUTE = 'data-testid';

export class PlaywrightSurface {
  /**
   * Errors raised where nobody awaits them (dialog routing, route handlers)
   * wait here and fail the next step that enters the surface.
   */
  latch = new ErrorLatch();
  dialogs = new DialogRouter(this.latch);

  private readonly browserName: BrowserName;
  private readonly connection = new BrowserConnection();
  private readonly chromiumSandbox: boolean;
  /** What the options add to the launch of the browser the engine launches. */
  private readonly launch: BrowserLaunchOptions;
  private readonly connect: WebConnectOptions | undefined;
  /** The provider's browsers, when `browser` names one; the runner and worker halves of the lease bookkeeping. */
  private readonly leases: LeasedBrowsers | undefined;
  private session: AttemptSession | undefined;
  /** Set by `init`: a handle no target runs on never gets there. */
  private started = false;
  private readonly usedContexts = new Set<string>();
  private readonly viewport: ViewportSize | null;
  private readonly deviceScaleFactor: number | undefined;
  private readonly screencast: WebScreencastOptions;
  /** Injected request headers, names lowercased so they replace the browser's own of the same name. */
  private readonly headers: Readonly<Record<string, string>> | undefined;
  private readonly credentialOrigins: readonly string[] | undefined;
  /** Where `headers` and `basicAuth` go: the app's origin and each of `credentialOrigins`, set at `init`. */
  private credentialScope: ReadonlySet<string> = new Set();
  private readonly basicAuth: WebBasicAuth | undefined;
  private readonly testIdAttribute: string;
  private readonly userAgent: string | undefined;
  private readonly locale: string | undefined;
  private readonly timezoneId: string | undefined;
  /** The configured media features, which every attempt starts from. */
  private readonly media: WebMedia;
  private readonly configuredInitScripts: ConfiguredInitScripts;
  /**
   * What every document of the attempt runs before the page's own scripts,
   * in the order it was added: the configured init scripts, then the test's
   * init scripts and successful clock calls. Each context the attempt opens
   * applies it, so a replacement context gives its documents the same order.
   */
  private documentSetup: DocumentSetup[] = [];
  /** Whether the attempt called `browser.clock`, even a call that failed after Playwright installed it. */
  private clockState = { used: false };
  private app: EngineAppInfo = {};
  private projectRoot = '';
  private headed = false;
  private artifactsDir = '';
  /** Navigations the engine has in flight, which the app log leaves to the step that started them. */
  private ownNavigations = 0;
  /** One entry per navigation in flight, set to the URL of a document request a test route aborted during it. */
  private readonly navigationAborts = new Set<{ url?: string }>();
  /** What the attempt tells its trace beside the app log; absent between attempts. */
  private trace: TraceFeed | undefined;
  private artifactCounter = 0;
  /**
   * Attempt-scoped network routes. Registered on the
   * context, not a page, so they cover every page the attempt opens - the
   * first navigation included - and re-applied to each context the attempt
   * replaces on `reset` or session restore.
   */
  private routes: StoredRoute[] = [];

  constructor(options: WebOptions) {
    this.browserName = typeof options.browser === 'string' ? options.browser : 'chromium';
    this.chromiumSandbox = options.chromiumSandbox ?? defaultChromiumSandbox();
    this.leases = typeof options.browser === 'object' && options.browser !== null ? new LeasedBrowsers(options.browser) : undefined;
    this.connect = options.connect;
    this.launch = options.webmcp === true ? webmcpLaunch(this.browserName) : {};
    this.viewport = options.viewport === undefined ? DEFAULT_VIEWPORT : options.viewport;
    this.deviceScaleFactor = options.deviceScaleFactor;
    this.screencast = options.screencast ?? {};
    this.headers = options.headers === undefined ? undefined : lowercaseNames(options.headers);
    this.credentialOrigins = options.credentialOrigins;
    this.basicAuth = options.basicAuth;
    this.testIdAttribute = options.testIdAttribute ?? DEFAULT_TEST_ID_ATTRIBUTE;
    this.userAgent = options.userAgent;
    this.locale = options.locale;
    this.timezoneId = options.timezoneId;
    this.media = obj({ colorScheme: options.colorScheme, reducedMotion: options.reducedMotion });
    this.configuredInitScripts = new ConfiguredInitScripts(options.initScripts ?? []);
  }

  // --- lifecycle ---

  /**
   * Installs the browser on first run, once per run before any worker, or
   * leases the run's browsers from a provider. A CDP attach uses the
   * remote's browser, so only a local launch needs the browser here. The
   * download narrates through `info.log` and is bounded by the run's
   * interrupt alone, never by a launch budget. Init scripts are read first
   * so a missing file fails the run before any worker starts.
   */
  async prepare(info: EnginePrepareInfo): Promise<EnginePrepareResult | void> {
    await this.configuredInitScripts.load(info.projectRoot);
    if (this.leases !== undefined) return this.leases.prepare(info);
    if (this.connect !== undefined) return;
    await ensureBrowsersInstalled([this.browserName], { env: info.env, signal: info.signal, log: info.log, headed: info.headed });
  }

  /**
   * The checks of `e2e doctor`: the init scripts `prepare` reads, and the
   * browser, which only a local launch needs on this machine.
   */
  async doctor(info: EngineDoctorInfo): Promise<readonly EngineDoctorCheck[]> {
    const scripts = await this.configuredInitScripts.doctor(info.projectRoot);
    if (this.leases !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: `browsers come from the "${this.leases.name}" provider` }];
    if (this.connect !== undefined) return [...scripts, { id: 'browser', status: 'skip', message: 'the browser is attached over CDP' }];
    return [...scripts, ...(await browserCheck(this.browserName, info.env, info.headed))];
  }

  /** Releases the browsers `prepare` leased; a local launch or a `connect` has nothing to release. */
  async finish(info: EngineFinishInfo): Promise<void> {
    await this.leases?.finish(info);
  }

  /** Provisions the shared browser once per worker: a local launch, or a CDP attach. */
  async init(info: EngineInitInfo): Promise<void> {
    this.started = true;
    // A runner older than the peer floor passes no origin; fail rather than send the credentials nowhere.
    if (info.app.origin === undefined && (this.headers !== undefined || this.basicAuth !== undefined)) {
      throw new ConfigurationError('INVALID_CONFIG', 'web({ headers, basicAuth }) needs an e2e runner that tells the engine the app\'s origin; update e2e to the release beside this @e2e-dev/web');
    }
    this.app = info.app;
    this.credentialScope = credentialOrigins(info.app.origin, this.credentialOrigins);
    this.projectRoot = info.projectRoot;
    this.headed = info.headed;
    this.leases?.init(info);
    // The browser was installed in `prepare`; a launch or attach is the one
    // boot step left that can outlive a launch budget, and it honours the
    // init signal. A failed init-script read throws only after the launch
    // settles, so `dispose` owns the browser.
    const settled = await Promise.allSettled([
      this.configuredInitScripts.load(info.projectRoot),
      this.persistent ? undefined : this.acquireBrowser(info.signal),
    ]);
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
  }

  /** Whether attempts ride a persistent remote context, provisioned per attempt, instead of contexts on one shared browser. */
  private get persistent(): boolean {
    return this.connect?.reconnectEndpoint !== undefined || this.leases?.scope === 'attempt';
  }

  /**
   * Provisions the shared browser through the shared connection — a launch, or a CDP attach
   * via the connector — bounded by `signal`. Checked before the endpoint is
   * resolved: a cancelled caller must never provision a remote session it will
   * not use.
   */
  private async acquireBrowser(signal: AbortSignal): Promise<Browser> {
    const verb = this.connect === undefined && this.leases === undefined ? 'launch' : 'connect';
    if (signal.aborted) throw cancelled(`browser ${verb} cancelled`);
    try {
      return await raceAbort(
        this.connection.acquire({
          name: this.browserName,
          headed: this.headed,
          timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
          chromiumSandbox: this.chromiumSandbox,
          launch: this.launch,
          connect: this.connector(signal),
        }),
        signal,
        `browser ${verb}`,
      );
    } catch (cause) {
      if (cause instanceof EngineError) throw cause;
      // The probe is the one await after the launch settled, so it stops with the init signal too.
      const missing = verb === 'launch' ? await missingBrowserLibraries(this.browserName, process.env, this.headed, { signal }) : [];
      // The launch's own reason follows the advice: it can name a second fault the libraries do not explain.
      const reason = missing.length > 0 ? `${missingLibrariesMessage(this.browserName, missing)}\nlaunch error: ${message(cause)}` : message(cause);
      throw new EngineError('ENGINE_FAILURE', `browser ${verb} failed: ${reason}`, {
        retryable: false,
        cause,
      });
    }
  }

  /**
   * Builds the connection's connector when attaching over CDP; undefined for a local
   * launch. The connector honours `signal` at every await: the resolver
   * receives it, the endpoint is not used once aborted, and a browser that
   * connects after cancellation is detached at once rather than cached — the
   * host's session is never held by an init or attempt that already gave up.
   */
  private connector(signal: AbortSignal): (() => Promise<Browser>) | undefined {
    const source = this.endpointSource();
    if (source === undefined) return undefined;
    return async () => {
      const resolved = await source.resolve(signal);
      const target = typeof resolved === 'string' ? { endpoint: resolved } : resolved;
      if (signal.aborted) throw cancelled('browser connect cancelled');
      if (typeof target?.endpoint !== 'string' || target.endpoint.trim() === '') {
        throw new EngineError('ENGINE_FAILURE', `${source.name} resolved to an empty CDP endpoint`, {
          retryable: false,
        });
      }
      const browser = await connectCdp(target, BROWSER_LAUNCH_TIMEOUT_MS);
      if (signal.aborted) {
        await browser.close().catch(() => undefined);
        throw cancelled('browser connect cancelled');
      }
      return browser;
    };
  }

  /**
   * Where the shared browser's CDP endpoint comes from: the `connect`
   * resolver, or the lease the worker holds from a provider; undefined for a
   * local launch.
   */
  private endpointSource(): { readonly name: string; readonly resolve: CdpEndpointResolver } | undefined {
    if (this.connect !== undefined) return { name: 'connect.cdpEndpoint', resolve: this.connect.cdpEndpoint };
    if (this.leases === undefined) return undefined;
    return { name: 'the browser provider', resolve: (signal) => this.leaseEndpoint(signal) };
  }

  /** The endpoint of the lease the worker holds; only reached with a provider. */
  private leaseEndpoint(signal: AbortSignal): ReturnType<LeasedBrowsers['endpoint']> {
    if (this.leases === undefined) throw invalidState('no browser provider is configured');
    return this.leases.endpoint(signal);
  }

  /**
   * The persistent remote context this attempt rides, when it does: the
   * `connect` resolvers, or a browser leased for this attempt alone, which
   * reconnects through the lease's own endpoint and is fresh by the
   * provider's contract, so no earlier attempt's context is checked against
   * it. Undefined for isolated contexts on the shared browser.
   */
  private async persistentBinding(
    context: EngineAttemptContext,
  ): Promise<{ provision: CdpEndpointResolver; reconnect: CdpEndpointResolver; usedContexts?: Set<string> } | undefined> {
    const { connect, usedContexts } = this;
    if (connect?.reconnectEndpoint !== undefined) {
      return { provision: connect.cdpEndpoint, reconnect: connect.reconnectEndpoint, usedContexts };
    }
    if (this.leases?.scope !== 'attempt') return undefined;
    const leases = this.leases;
    const lease = await leases.startAttempt(context);
    return {
      provision: (signal) => leases.cdpTarget(lease, signal),
      reconnect: (signal) => leases.cdpTarget(lease, signal, lease.reconnectEndpoint ?? lease.cdpEndpoint),
    };
  }

  /** Opens one attempt owner before setup starts, so cleanup can cancel pending attachment. */
  async startAttempt(context: EngineAttemptContext): Promise<void> {
    if (this.session !== undefined) throw invalidState('an attempt is already running');
    // Raced with the launch budget: a provider still resolving when the
    // runner gives up must not open a session after the runner ended it.
    const basicAuth = this.basicAuth;
    const credentials =
      basicAuth === undefined
        ? undefined
        : await raceAbort(
            () => httpCredentials(basicAuth, this.credentialScope, this.browserName, context.resolveSecret),
            context.signal,
            'resolving the basic-auth password',
          );
    const persistent = await this.persistentBinding(context);
    this.artifactsDir = context.artifactsDir;
    this.artifactCounter = 0;
    this.trace = new TraceFeed(context, () => this.openPage(), () => this.session?.refs, { testIdAttribute: this.testIdAttribute, site: this.app.site });
    const routes: StoredRoute[] = [];
    const initScripts = this.configuredInitScripts.forAttempt();
    // `validateApp` admitted only grants.
    const granted = grantedPermissions(this.browserName, this.app);
    this.latch = new ErrorLatch();
    const dialogs = new DialogRouter(this.latch);
    const documentSetup: DocumentSetup[] = initScripts.map((script) => ({ script }));
    const clockState = { used: false };
    this.routes = routes;
    this.documentSetup = documentSetup;
    this.clockState = clockState;
    this.dialogs = dialogs;
    const session = new AttemptSession({
      artifactsDir: context.artifactsDir,
      viewport: this.viewport,
      screencast: this.screencast,
      media: this.media,
      acquire: (signal) => this.acquireBrowser(signal),
      contextOptions: {
        viewport: this.viewport,
        ...(this.deviceScaleFactor === undefined ? {} : { deviceScaleFactor: this.deviceScaleFactor }),
        acceptDownloads: true,
        ...(credentials === undefined ? {} : { httpCredentials: credentials }),
        ...(this.userAgent === undefined ? {} : { userAgent: this.userAgent }),
        ...(this.locale === undefined ? {} : { locale: this.locale }),
        ...(this.timezoneId === undefined ? {} : { timezoneId: this.timezoneId }),
        // On the context too, so a tab the app opens itself paints with the configured values before the session reaches it.
        ...this.media,
        ...(this.headers === undefined ? {} : { serviceWorkers: 'block' as const }),
      },
      configure: async (target) => {
        await target.addInitScript(CLOSED_SHADOW_ROOTS_INIT_SCRIPT);
        await target.addInitScript(MODAL_ORDER_INIT_SCRIPT);
        // A fresh context has no document yet, so a clock call only registers the clock's script and its log.
        for (const setup of documentSetup) {
          if ('script' in setup) await target.addInitScript(setup.script);
          else await applyClockCall(target.clock, setup.clock);
        }
        target.setDefaultTimeout(CONTEXT_DEFAULT_TIMEOUT_MS);
        target.on('dialog', (dialog) => { void dialogs.dispatch(dialog); });
        installAppLog(target, context.appLog, {
          navigated: context.navigation,
          ownNavigation: () => this.ownNavigations > 0,
          testPage: () => this.openPage(),
        });
        await installConfiguredHeaders(target, this.credentialScope, this.headers);
        if (granted.length > 0) await grantPermissions(target, granted, this.app.allPermissions === true);
        for (const stored of routes) await target.route(stored.predicate, stored.handler);
      },
      clockUsed: () => clockState.used,
      ...(persistent === undefined ? {} : { persistent }),
      record: this.leases?.recorder(context.attemptId),
    });
    this.session = session;
    await session.start(context.signal);
  }

  /**
   * Waits for a route or dialog handler still running, then rethrows the
   * error one of them latched after the last step, so it fails this attempt
   * instead of the next one's first operation. The latch itself is replaced
   * by `startAttempt`, after this ran.
   */
  settleAttempt(context: EngineCleanupContext): Promise<void> {
    return this.latch.settle(context);
  }

  /**
   * Retires the owner before awaiting cleanup; late work cannot reach the
   * next attempt. A browser leased for the attempt is released after its
   * connection closes, whether or not the close succeeded.
   */
  async endAttempt(context: EngineCleanupContext): Promise<void> {
    const session = this.session;
    this.session = undefined;
    try {
      if (session !== undefined) await session.close(context);
    } finally {
      await this.leases?.endAttempt(context);
    }
  }

  /**
   * Releases attempt resources, the worker's shared browser process, and a
   * lease the worker acquired for itself: three independent tasks, in that
   * order, every one attempted whatever the earlier ones did, and the first
   * failure reported once all ran. A billed browser outlives a failed
   * recording flush otherwise.
   */
  async dispose(context: EngineCleanupContext): Promise<void> {
    const tasks = [
      () => this.endAttempt(context),
      () => withinCleanupBudget(this.connection.dispose(), context),
      async () => this.leases?.dispose(context),
    ];
    let failure: { cause: unknown } | undefined;
    for (const task of tasks) {
      try {
        await task();
      } catch (cause) {
        failure ??= { cause };
      }
    }
    if (failure !== undefined) throw translatePwError(failure.cause, 'dispose');
  }

  /** Returns the active attempt, including its connection generation and references. */
  private requireSession(): AttemptSession {
    if (this.session === undefined) {
      throw invalidState(this.started ? 'no attempt is running' : 'no attempt is running on this engine handle, which has not started in this process: use the handle the target runs on, not a new web(), from code a test runs');
    }
    return this.session;
  }

  /** Adds one attempt-scoped init script to the current context, for every document it creates from now on. */
  async addInitScript(source: string): Promise<void> {
    const context = this.requireContext();
    this.documentSetup.push({ script: source });
    await context.addInitScript(source);
  }

  /**
   * Runs one clock call on the current context and logs it for a context
   * that replaces this one. Playwright logs the call for the context's next
   * documents before it runs it, so the call is logged whether it succeeds
   * or fails, and a replacement context replays what a new document would.
   * The attempt counts as using the clock from the start of the call:
   * Playwright installs the clock before a call can fail. The log is the one
   * this attempt started with, so a call that resolves after its step timed
   * out never reaches the next attempt's.
   */
  async clock(call: ClockCall): Promise<void> {
    const setup = this.documentSetup;
    const { clock } = this.requireContext();
    this.clockState.used = true;
    try {
      await applyClockCall(clock, call);
    } finally {
      setup.push({ clock: call });
    }
  }

  /**
   * The latest time a page clock of the current context reads, across every
   * frame, or undefined when none has one yet. Playwright runs a call in
   * every frame and fails it when one frame refuses, so the latest decides.
   */
  async clockNow(): Promise<number | undefined> {
    const frames = this.requireContext().pages().flatMap((page) => page.frames());
    // A frame that detaches or navigates while it is read has no clock to compare with.
    const times = await Promise.all(frames.map((frame) => frame.evaluate(readClockNow).catch(() => undefined)));
    const read = times.filter((time) => typeof time === 'number');
    return read.length === 0 ? undefined : Math.max(...read);
  }

  // --- network routes shared with the browser fixture ---

  /** Registers one attempt-scoped route on the current context. */
  async route(predicate: RoutePredicate, handler: RouteHandler): Promise<void> {
    const context = this.requireContext();
    this.routes.push({ predicate, handler });
    await context.route(predicate, handler);
  }

  /** The configured headers a request to `url` carries, lowercased; `undefined` off the app's origin and `credentialOrigins`. */
  configuredHeaders(url: string): Readonly<Record<string, string>> | undefined {
    return configuredHeadersFor(url, this.credentialScope, this.headers);
  }

  /** Resolves a file a test names against the project root, as config paths do, never `process.cwd()`. */
  projectPath(file: string): string {
    return path.resolve(this.projectRoot, file);
  }

  /** Removes one registered route from the attempt and the current context. */
  async unroute(predicate: RoutePredicate, handler: RouteHandler): Promise<void> {
    const context = this.requireContext();
    const index = this.routes.findIndex(
      (stored) => stored.predicate === predicate && stored.handler === handler,
    );
    if (index !== -1) this.routes.splice(index, 1);
    await context.unroute(predicate, handler);
  }

  // --- page access shared with the browser fixture ---

  /**
   * The attempt's open page, or undefined, for a reader beside the test (the
   * trace): unlike `requirePage`, it leaves an error a handler latched for
   * the test's next operation to throw.
   */
  private openPage(): Page | undefined {
    try {
      const page = this.session?.current().page ?? null;
      return page === null || page.isClosed() ? undefined : page;
    } catch {
      return undefined;
    }
  }

  requirePage(): Page {
    this.latch.throwPending();
    const page = this.requireSession().current().page;
    if (page === null || page.isClosed()) throw invalidState('no app page is open; call app.open() or browser.goto() first');
    return page;
  }

  requireContext(): BrowserContext {
    this.latch.throwPending();
    return this.requireSession().current().context;
  }

  /**
   * The downloads of a leased browser, read through its provider, when the
   * provider serves them; undefined for a local launch, a `connect`, or a
   * provider that does not, whose downloads Playwright saves as usual.
   */
  remoteDownloads(): LeaseDownloads | undefined {
    return this.leases?.downloads();
  }

  /** Why a download from a leased browser may never reach the runner, when its provider serves none. */
  unservedDownloads(): string | undefined {
    if (this.leases === undefined || this.leases.downloads() !== undefined) return undefined;
    return `browser provider "${this.leases.name}" serves no downloads, so a browser on another machine keeps the file on its own disk (BrowserProvider.downloads)`;
  }

  /** Creates the active page through the attempt's sole binding owner. */
  ensurePage(): Promise<Page> {
    return this.requireSession().ensurePage();
  }

  /** Sizes the open page, or the one the next navigation opens, for the rest of the attempt. */
  setViewport(size: { readonly width: number; readonly height: number }): Promise<void> {
    return this.requireSession().setViewport(size);
  }

  /** Emulates media features on the open page, or the one the next navigation opens, for the rest of the attempt. */
  emulateMedia(media: WebMedia): Promise<void> {
    return this.requireSession().emulateMedia(media);
  }

  /** Takes the attempt's browser offline or back online, for the rest of the attempt. */
  setOffline(offline: boolean): Promise<void> {
    return this.requireSession().setOffline(offline);
  }

  /**
   * The single entry of every operation: rethrows an error latched on an
   * unawaited path, refuses a cancelled operation, races `fn` against the
   * operation signal so an abort mid-call surfaces as `CANCELLED` instead of
   * waiting out Playwright, bounds it by the operation's budget so a call a
   * hung page never answers is `OPERATION_TIMEOUT`, and translates raw errors at the contract
   * boundary. `translate` overrides the default translation for operations
   * with a documented retryable failure mode; `bound` is `test-code` for an
   * operation that runs the test's own code, which the deadline never cuts.
   */
  async guard<T>(
    operation: OperationContext,
    label: string,
    fn: (operation: OperationContext) => Promise<T>,
    translate: (cause: unknown, label: string) => Error = translatePwError,
    bound: OperationBound = 'deadline',
  ): Promise<T> {
    this.latch.throwPending();
    try {
      return this.session === undefined
        ? await withOperationDeadline(operation, label, (remaining) => fn({ ...operation, ...remaining() }), bound)
        : await this.session.run(operation, label, fn, bound);
    } catch (cause) {
      // A handler error latched while the operation ran is its cause: a route
      // that refused its own arguments aborts the request the step waited on.
      this.latch.throwPending();
      throw translate(cause, label);
    }
  }

  // --- steering: the session hooks ---

  /** Opens one URL the harness resolved; the attempt's page is created on first use. */
  open(url: string, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'navigation', (currentOperation) =>
      this.navigating(async () => {
        const page = await this.ensurePage();
        await page.goto(url, { waitUntil: 'load', timeout: currentOperation.timeoutMs });
      }),
    ));
  }

  back(operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'navigation', (currentOperation) =>
      this.navigating(async () => {
        await this.requirePage().goBack({ waitUntil: 'load', timeout: currentOperation.timeoutMs });
      }),
    ));
  }

  /** Shows the open tab at `index`, in opening order, for the agent's `switchTab` verb, and shows the screen after it. */
  switchTab(index: number, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'switch tab', () => this.requireSession().showTabAt(index)));
  }

  /** Closes the open tab at `index`, in opening order, for the agent's `closeTab` verb, and shows the screen after it. */
  closeTabAt(index: number, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'close tab', () => this.requireSession().closeTabAt(index)));
  }

  // --- identity shared with the browser fixture ---

  /**
   * Reads the engine and version of the browser the attempt is connected to,
   * both asked of the driver: a browser attached over CDP was not launched
   * from `web({ browser })`, and its version is no package's. The reader
   * belongs to the session running when it is made, or else to the first it
   * reads: a fixture kept past its attempt gets no answer from the next
   * attempt's browser, which a provider may have leased anew. The owner is
   * the session, not an attempt id, because the members of a serial group
   * share one session under ids of their own. `ended` is the fixture's own
   * signal: a fixture first made after its attempt ended would otherwise
   * take the next attempt's session for its own.
   */
  browserIdentity(ended: () => AbortSignal): () => { readonly name: BrowserName; readonly version: string } {
    let owner = this.session;
    return () => {
      const session = this.requireSession();
      owner ??= session;
      if (session !== owner || ended().aborted) throw invalidState('the attempt this browser belongs to has ended');
      const { browser } = session.current();
      const name = browser.browserType().name();
      if (!isBrowserName(name)) {
        throw new EngineError('ENGINE_FAILURE', `the driver reported an unknown browser "${name}"`, { retryable: false });
      }
      return { name, version: browser.version() };
    };
  }

  // --- tabs shared with the browser fixture ---

  /** The attempt's open tabs, in the order they opened. */
  tabs(): readonly AttemptTab[] {
    this.latch.throwPending();
    return this.requireSession().openTabs();
  }

  /** The tab the attempt shows, if one is open. */
  shownTab(): AttemptTab | undefined {
    return this.session?.shownTab();
  }

  /** Shows one of the attempt's tabs (`BrowserTab.activate`). */
  showTab(tab: AttemptTab, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'tab', () => this.requireSession().showTab(tab));
  }

  /** Opens a blank tab in the attempt's context and shows it (`browser.newTab`). */
  newTab(operation: OperationContext): Promise<AttemptTab> {
    return this.guard(operation, 'tab', () => this.requireSession().newTab());
  }

  /** Closes one of the attempt's tabs (`BrowserTab.close`); the tab shown next is shown before it resolves. */
  closeTab(tab: AttemptTab, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'tab', () => this.requireSession().closeTab(tab));
  }

  /** Waits for the next tab the app opens and shows it (`browser.waitForPopup`). */
  nextPopup(signal: AbortSignal): ReturnType<AttemptSession['nextPopup']> {
    return this.requireSession().nextPopup(signal);
  }

  /** Sets the viewport for the agent's `resize` verb, as `browser.setViewport` does, and shows the screen after it. */
  resize(size: ViewportSize, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'resize', () => this.setViewport(size)));
  }

  /**
   * Runs one navigation the engine itself makes, so the app log leaves it to
   * the step that asked for it. A navigation that fails after a test route
   * aborted its document request, or while the test holds the browser
   * offline, failed because of what the test did: an action failure, not an
   * engine fault.
   */
  async navigating<T>(work: () => Promise<T>): Promise<T> {
    this.ownNavigations += 1;
    const watch: { url?: string } = {};
    this.navigationAborts.add(watch);
    try {
      const result = await work();
      this.trace?.tellEnvironment();
      return result;
    } catch (cause) {
      if (isClassified(cause) || isPwTimeout(cause)) throw cause;
      const reason = watch.url !== undefined
        ? `a route aborted the request for ${watch.url}`
        : this.session?.navigatedOffline() === true
          ? "the browser is offline (browser.setNetwork('offline'))"
          : undefined;
      if (reason === undefined) throw cause;
      throw new TestError('ACTION_FAILED', `navigation failed: ${reason}: ${message(cause)}`, { cause });
    } finally {
      this.navigationAborts.delete(watch);
      this.ownNavigations -= 1;
    }
  }

  /**
   * Records a request a test route is about to abort, when it loads the
   * document of the attempt's page. Never throws: the abort must follow.
   */
  noteRouteAbort(request: Request): void {
    if (this.navigationAborts.size === 0 || !request.isNavigationRequest()) return;
    const main = this.openPage()?.mainFrame();
    if (main === undefined || frameOf(request) !== main) return;
    for (const watch of this.navigationAborts) watch.url ??= request.url();
  }

  /**
   * Runs page code that may send the page to another document. When it fails
   * because the page navigated under it, the new document is left to load
   * before the failure is thrown, so the step after it does not race that
   * navigation. The failure itself is thrown unchanged.
   */
  async throughNavigation<T>(page: Page, operation: OperationContext, work: () => Promise<T>): Promise<T> {
    const deadline = new Deadline(operation.timeoutMs);
    const documents = watchDocuments(page);
    try {
      return await work();
    } catch (cause) {
      if (isNavigationRace(cause) && !isPwTimeout(cause) && !operation.signal.aborted) {
        // As in `screenshot`: the rejection can arrive before the commit's `framenavigated`.
        await documents.whenReplaced(Math.min(NAVIGATION_EVENT_GRACE_MS, deadline.remaining()));
        if (documents.replaced()) {
          await page.waitForLoadState('load', { timeout: Math.max(1, deadline.remaining()) }).catch(() => undefined);
        }
      }
      throw cause;
    } finally {
      documents.stop();
    }
  }

  /** Resolves with what an action resolved with once the trace has the screen it left (`TraceFeed.screenAfterAction`); an action that failed leaves none. */
  private async acted<T>(operation: OperationContext, work: Promise<T>): Promise<T> {
    const result = await work;
    await this.trace?.screenAfterAction(operation);
    return result;
  }

  /** Restarts the document while retaining this attempt's context and storage. */
  restart(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'restart', () => this.requireSession().restart());
  }

  /** Replaces the context with a clean one and opens its blank page. */
  reset(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state reset', async (currentOperation) => {
      const session = this.requireSession();
      await session.replace(undefined, currentOperation);
      await session.ensurePage();
    });
  }

  /** Reads computed styles from the element an observation ref names, without input or actionability waits. */
  async readStyle(ref: NodeRef, properties: readonly ComputedStyleProperty[], operation: OperationContext): Promise<ComputedStyleValues> {
    const requested = validateComputedStyleProperties(properties);
    return this.guard(operation, 'read computed style', async (currentOperation) => {
      const target = await this.requireSession().refs.lookup(ref);
      if (target.kind !== 'element') {
        throw new EngineError('NODE_STALE', `node reference ${ref.id} is not from an observation`, { retryable: false });
      }
      currentOperation.signal.throwIfAborted();
      const style = await target.element.evaluate((element, names) => {
        const view = element.ownerDocument.defaultView;
        if (!element.isConnected || view === null) return null;
        const computed = view.getComputedStyle(element);
        return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name)]));
      }, requested);
      if (style === null) throw new EngineError('NODE_STALE', 'node is detached; observe again before reading', { retryable: true });
      return style;
    }, navigationStaleOr);
  }

  /**
   * Measures how much of a located or observed element is inside the
   * viewport with the page's `IntersectionObserver`, the check Playwright's
   * `toBeInViewport` makes, so scrolling and overflow ancestors and frames
   * clip it. An element with no box, or an empty one, is outside. It runs
   * in the page's own world, as `readStyle` does, so an app that replaces
   * `IntersectionObserver` changes what it reads.
   */
  viewportIntersection(ref: NodeRef, operation: OperationContext): Promise<ViewportIntersection> {
    return this.guard(operation, 'measure viewport intersection', (currentOperation) => this.readingTab(async () => {
      const target = await this.requireSession().refs.lookup(ref);
      let element: ElementHandle;
      if (target.kind === 'element') {
        element = target.element;
      } else {
        // A strict locator that matches anything but one element no longer names the node it located.
        const handles = await target.locator.elementHandles();
        if (handles.length !== 1) {
          for (const handle of handles) void handle.dispose().catch(() => undefined);
          throw new EngineError('NODE_STALE', `node reference ${ref.id} no longer matches one element`, { retryable: true });
        }
        element = handles[0]!;
      }
      try {
        currentOperation.signal.throwIfAborted();
        const measured = await element.evaluate(measureViewportIntersection);
        if (measured === 'detached') throw new EngineError('NODE_STALE', 'node is detached; locate it again', { retryable: true });
        if (measured === 'unsupported') {
          throw new EngineError('UNSUPPORTED_CAPABILITY', 'the browser has no IntersectionObserver to measure the viewport with', {
            retryable: false,
          });
        }
        return measured;
      } finally {
        if (target.kind === 'locator') void element.dispose().catch(() => undefined);
      }
    }), navigationStaleOr);
  }

  // --- location tier ---

  /**
   * Resolves one expression to every node it currently matches, fully read,
   * in one in-page round trip. A `displayValue` query is filtered here by the
   * value each element reported, so no per-node calls are needed; any
   * `first`/`last`/`nth` on such a query then selects among those matches, and
   * a filter placed after a position is checked on the selected element. A
   * `visible` query drops the candidates whose hidden state the same read
   * reported before either of those, so a position is among shown matches.
   */
  locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    return this.guard(
      operation,
      'locate',
      (currentOperation) => this.readingTab(async () => {
        try {
          return await this.locateNow(expression, currentOperation);
        } catch (cause) {
          throw (await pageScriptFailure(this.frameScope(expression), cause, 'locate', currentOperation.timeoutMs)) ?? cause;
        }
      }),
      staleOr,
    );
  }

  /**
   * Runs a read of the tab the attempt shows. A tab the app closes under the
   * read makes it stale, as a navigation does: nothing was dispatched, and
   * the read repeats on the tab shown next.
   */
  private async readingTab<T>(read: () => Promise<T>): Promise<T> {
    const session = this.session;
    const page = this.openPage();
    try {
      return await read();
    } catch (cause) {
      if (page !== undefined && session?.tabClosed(page) === true) {
        throw new EngineError('NODE_STALE', 'the tab closed while it was read', { retryable: true, cause });
      }
      throw cause;
    }
  }

  /** The body of `locate`, inside its guard. */
  private async locateNow(expression: LocatorExpression, currentOperation: OperationContext): Promise<readonly SemanticNode[]> {
    const session = this.requireSession();
    const token = session.token();
    const refs = session.refs;
    const page = this.requirePage();
    const frame = await this.frameOf(expression);
    const projected = projectExpression(page, expression, { testIdAttribute: this.testIdAttribute, frameHidden: frame.hidden });
    const { displayValue, name, steps } = projected;
    // Every match is read by the `e2e-read` selector engine in the task that finds it, so a
    // page that replaces it a frame later cannot detach it before the read. A
    // predicate-filtered match is one element among many candidates (every input with a
    // value, every control the label engine kept). Re-resolving it by position at action
    // time would act on a neighbor whenever the page inserted or removed an element in
    // between, so such matches are pinned to the handles of the elements the query returned,
    // and their reads are taken back from those very handles: what was read and what is
    // acted on are one set of elements by construction.
    const read = readSelector({ testIdAttribute: this.testIdAttribute, secureFieldSelector: SECURE_FIELD_SELECTOR });
    const reading = projected.locator.locator(read.selector);
    const handles =
      displayValue !== null || name !== null
        ? ((await reading.elementHandles()) as ElementHandle<Element>[])
        : null;
    /** Disposes every handle this locate took, on the paths that hand none of them out. */
    const releaseHandles = (): void => {
      for (const handle of handles ?? []) void handle.dispose().catch(() => undefined);
    };
    const first = handles?.[0];
    const taken =
      handles === null
        ? await reading.evaluateAll(takeReadsFunction, { token: read.token })
        : first === undefined
          ? []
          : await first.evaluate(takeReadsFunction, { token: read.token, elements: handles });
    const reads = taken
      .filter((raw) => raw !== null)
      .map((raw) => (frame.hidden ? { ...raw, states: { ...raw.states, hidden: true } } : raw));
    if (reads.length !== taken.length) {
      releaseHandles();
      throw new TestError(
        'INVALID_LOCATOR',
        'a selector that captures with * (*css=article >> text=Hello) is not supported: use filter({ has }) instead',
      );
    }
    const candidates = reads.flatMap((raw, index) => (projected.visible && raw.states.hidden ? [] : [{ raw, index }]));
    // An exact label query matches any of the control's labels as the engine's reader names
    // them, so text a label marks aria-hidden (a required-field marker) never hides a field,
    // and an aria-label override or a second label does not either.
    const predicate =
      displayValue !== null
        ? (raw: RawNodeData) => matchesText(raw.value ?? '', displayValue)
        : name !== null
          ? (raw: RawNodeData) =>
              raw.labels !== null && raw.labels.some((label) => matchesText(label, name))
          : null;
    const matches =
      predicate === null
        ? candidates
        : await applyPostSteps(
            candidates.filter(({ raw }) => predicate(raw)),
            steps,
            // A filter after a position runs on that one element alone.
            async ({ index }, options) =>
              (await projected.locator.nth(index).filter(options).count()) > 0,
          );
    if (currentOperation.signal.aborted) {
      releaseHandles();
      throw cancelled('locate cancelled');
    }
    try { session.check(token); } catch (cause) {
      releaseHandles();
      throw cause;
    }
    if (handles !== null) {
      // Only the matches keep their handles; the rest would otherwise live until the page goes.
      const kept = new Set(matches.map(({ index }) => index));
      for (const [index, handle] of handles.entries()) {
        if (!kept.has(index)) void handle.dispose().catch(() => undefined);
      }
    }
    return matches.map(({ raw, index }) => {
      const pinned = handles?.[index];
      // A single match keeps the strict locator, so a ref that turns
      // ambiguous between locate and perform is stale instead of acting
      // on whichever element is first.
      const locator = reads.length === 1 ? projected.locator : projected.locator.nth(index);
      const id = refs.storeLocated(
        pinned === undefined ? { kind: 'locator', locator } : { kind: 'element', element: pinned },
      );
      return inFrame(toSemanticNode({ id, revision: '' }, raw), frame.box);
    });
  }

  /** The page or frame an expression's frame selectors lead to, unresolved. */
  private frameScope(expression: LocatorExpression): Page | FrameLocator {
    let scope: Page | FrameLocator = this.requirePage();
    for (const selector of frameSelectors(expression)) scope = scope.frameLocator(selector);
    return scope;
  }

  /**
   * One action on a located or observed node. A `swipe` on the observation
   * root is the viewport swipe: a wheel gesture sized by the viewport, with no
   * element resolved behind it, so it needs only the page. Every other action
   * on the root acts on the document element the root stands for.
   */
  perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(
      operation,
      action.kind,
      (currentOperation) => {
        const page = this.requirePage();
        if (action.kind === 'swipe' && ref.id === ROOT_NODE_ID) {
          this.requireSession().requireObservation();
          return performViewportSwipe(page, action.direction, action.momentum ?? 'none');
        }
        const session = this.requireSession();
        const { refs } = session;
        const character = action.kind === 'press' ? requireCharacterPress(action.key, this.browserName) : undefined;
        return refs.lookup(ref).then(async (target) => {
          currentOperation.signal.throwIfAborted();
          try {
            if (character === undefined) await dispatchLocatorAction(target, action, currentOperation, (other) => refs.lookup(other));
            else await pressCharacterOn(target, page, character, currentOperation, session.checkpoint(currentOperation.signal, action.kind));
          } catch (cause) {
            // The input went out and its own tab closed: closing was what it did.
            if (dispatchedInput(cause) && session.tabClosed(page)) return;
            throw cause;
          }
        });
      },
      (cause) => classifyActionError(cause, action),
    ));
  }

  /** One pointer action at a viewport point in CSS pixels, with nothing resolved behind it; see `dispatchPointerAction`. */
  performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, `${action.kind} at point`, (currentOperation) => {
      this.requireSession().requireObservation();
      return dispatchPointerAction(this.requirePage(), point, action, currentOperation.signal);
    }, classifyInputError));
  }

  /**
   * Types into whatever holds focus. Keystrokes into a document body are
   * accepted by the browser and lost, so the focused element is checked for
   * editability first and the call refuses rather than "typing" into nothing.
   * `replace` clears with select-all and delete: the only locator-free clear,
   * scoped by the browser to the whole editing host, so it is opt-in.
   */
  typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'keyboard.type', async (currentOperation) => {
      const session = this.requireSession();
      session.requireObservation();
      const checkpoint = session.checkpoint(currentOperation.signal, 'keyboard.type');
      const page = this.requirePage();
      await this.requireEditableFocus(page);
      checkpoint();
      if (options.replace) {
        await page.keyboard.press('ControlOrMeta+A');
        checkpoint();
        await page.keyboard.press('Delete');
        checkpoint();
      }
      await page.keyboard.type(text);
    }, classifyInputError));
  }

  /** Sends one key to whatever holds focus, in the contract's key grammar Playwright shares. */
  pressKey(key: string, operation: OperationContext): Promise<void> {
    return this.acted(operation, this.guard(operation, 'keyboard.press', (currentOperation) => {
      const session = this.requireSession();
      session.requireObservation();
      const character = requireCharacterPress(key, this.browserName);
      const page = this.requirePage();
      return character === undefined ? page.keyboard.press(key) : pressCharacter(page, character, session.checkpoint(currentOperation.signal, 'keyboard.press'));
    }, classifyInputError));
  }

  /**
   * Refuses focused typing when nothing that takes keystrokes has focus, in
   * any frame of the page. Text fields and contenteditable hosts take them;
   * so does any other focusable element the app made focusable (a canvas, a
   * widget with a tabindex and its own key handling), because focusing it is
   * how the app opted into keys. Focus on the body, a button, a link, a
   * select, or a non-text input means the keystrokes would be discarded.
   */
  private async requireEditableFocus(page: Page): Promise<void> {
    const editable = await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate((key) => {
            const recorded: WeakMap<Element, ShadowRoot> | undefined = Reflect.get(globalThis, Symbol.for(key));
            let active = document.activeElement;
            while (active !== null) {
              const root = active.shadowRoot ?? recorded?.get(active);
              const leaf = root?.activeElement;
              if (leaf === undefined || leaf === null) break;
              active = leaf;
            }
            if (active === null || active === document.body || active === document.documentElement) return false;
            if (active instanceof HTMLInputElement) {
              return !active.disabled && !active.readOnly && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color'].includes(active.type);
            }
            if (active instanceof HTMLTextAreaElement) return !active.disabled && !active.readOnly;
            if (active instanceof HTMLSelectElement || active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement ||
                active instanceof HTMLIFrameElement || active instanceof HTMLFrameElement) {
              return false;
            }
            return true;
          }, CLOSED_SHADOW_ROOTS_KEY)
          .catch(() => false),
      ),
    );
    if (!editable.some(Boolean)) {
      throw new EngineError(
        'NOT_ACTIONABLE',
        'nothing that takes keystrokes has focus: the typed text would reach no field. Tap the field first, or type into a listed input by id.',
        { retryable: false },
      );
    }
  }

  /**
   * Checks that every frame selector along the expression matches exactly one
   * element, each counted inside the frame before it, the way `project` walks
   * the same chain; a frame-scoped `count` is 0 until that frame's document
   * has loaded, which is what makes `FRAME_NOT_FOUND` worth retrying. Returns
   * the innermost frame's content box in the top-level viewport, where its
   * document's viewport starts (undefined for an expression in the main
   * document, null for a frame with no box), and
   * whether a frame along the chain is hidden: a frame element's own `hidden`
   * state, read in the document around it, so a cross-origin frame reads too.
   * Every node in a hidden frame is hidden, and so are the frames under it.
   */
  private async frameOf(expression: LocatorExpression): Promise<{ box: Rect | null | undefined; hidden: boolean }> {
    let scope: Page | FrameLocator = this.requirePage();
    let element: Locator | undefined;
    let hidden = false;
    for (const selector of frameSelectors(expression)) {
      let count: number;
      try {
        count = await scope.locator(selector).count();
        if (count === 1 && !hidden) hidden = (await scope.locator(selector).locator(SHOWN_SELECTOR).count()) === 0;
      } catch (cause) {
        throw translatePwError(cause, 'frame resolution');
      }
      if (count === 0) {
        throw new EngineError('FRAME_NOT_FOUND', `no frame matches ${selector}`, {
          retryable: true,
        });
      }
      if (count > 1) {
        throw new EngineError('FRAME_AMBIGUOUS', `${count} frames match ${selector}`, {
          retryable: false,
        });
      }
      element = scope.locator(selector);
      scope = scope.frameLocator(selector);
    }
    if (element === undefined) return { box: undefined, hidden };
    try {
      const border = await element.boundingBox();
      return { box: border === null ? null : contentBox(border, await element.evaluate(frameContentInset)), hidden };
    } catch (cause) {
      throw translatePwError(cause, 'frame resolution');
    }
  }

  // --- artifacts ---

  /**
   * Reserves one artifact path under the attempt directory: a per-attempt
   * counter keeps names unique, the label keeps them readable.
   */
  artifactPath(folder: string, label: string | undefined, extension: string): { relative: string; absolute: string } {
    this.artifactCounter += 1;
    const name = `${String(this.artifactCounter).padStart(3, '0')}${
      label === undefined ? '' : `-${sanitizeFilename(label)}`
    }${extension}`;
    const relative = path.posix.join(folder, name);
    const absolute = path.join(this.artifactsDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return { relative, absolute };
  }

  /** Redacted at the source: secure fields in every frame are masked, and the caret is hidden without editing styles, as in observation pixels. */
  screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    return this.guard(operation, 'screenshot', async (currentOperation) => {
      const { relative, absolute } = this.artifactPath('screenshots', label, '.png');
      const deadline = new Deadline(currentOperation.timeoutMs);
      // The masks are resolved in the document showing when the capture
      // starts. A capture that fails while the page replaces that document
      // is taken of the replacing one, masked by the same rule, within the
      // step's own deadline.
      for (;;) {
        const page = this.requirePage();
        const documents = watchDocuments(page);
        try {
          const masks = await secureFieldMasks(page);
          await withHiddenCaret(page, () => page.screenshot({
            path: absolute,
            timeout: Math.max(1, deadline.remaining()),
            caret: 'initial',
            ...maskOptions(masks),
          }));
          return relative;
        } catch (cause) {
          // The capture can reject before `framenavigated` is delivered. The
          // event is already in flight when the context was destroyed, so a
          // short wait tells a real navigation from an error that only looks
          // like one.
          if (!documents.replaced() && isNavigationRace(cause) && !isPwTimeout(cause) && !currentOperation.signal.aborted) {
            await documents.whenReplaced(Math.min(NAVIGATION_EVENT_GRACE_MS, deadline.remaining()));
          }
          if (!documents.replaced() || isPwTimeout(cause) || currentOperation.signal.aborted) throw cause;
          if (deadline.expired()) {
            throw new EngineError('OPERATION_TIMEOUT', `screenshot timed out: the page replaced its document during every capture for ${currentOperation.timeoutMs}ms`, {
              retryable: false,
              cause,
            });
          }
        } finally {
          documents.stop();
        }
      }
    });
  }

  /** Starts the attempt's video. */
  startVideo(operation: OperationContext): Promise<void> {
    return this.guard(operation, 'video', (current) => this.requireSession().startVideo(current.signal));
  }

  /** Finishes the attempt's recording and returns its finalized segments. */
  stopVideo(operation: OperationContext): Promise<readonly VideoSegment[]> {
    return this.requireSession().collectVideo(operation);
  }

  // --- state ---

  captureState(operation: OperationContext): Promise<EngineState> {
    return this.guard(operation, 'state capture', async () => {
      const storageState = await this.requireContext().storageState({ indexedDB: true });
      return { format: STATE_FORMAT, version: 1, data: storageState };
    });
  }

  /** Replaces the attempt's context with one seeded from the snapshot. */
  restoreState(state: EngineState, operation: OperationContext): Promise<void> {
    return this.guard(operation, 'state restore', async (currentOperation) => {
      if (state.format !== STATE_FORMAT || state.version !== 1) {
        throw new EngineError(
          'INVALID_STATE',
          `unsupported state format ${state.format}@${String(state.version)}`,
          { retryable: false },
        );
      }
      // A string here would be read by Playwright as a file path; a session
      // envelope must never be able to point the browser at the filesystem.
      if (!isStorageState(state.data)) {
        throw new EngineError('INVALID_STATE', 'state data must be a storage-state object', {
          retryable: false,
        });
      }
      await this.requireSession().replace(state.data, currentOperation);
    });
  }

  // --- observation ---

  /**
   * Captures one atomic semantic observation. Secure fields are masked in the
   * page before the tree leaves the engine, and every node stays reachable
   * through its document's element list until the next observation replaces
   * the generation; an action makes the node's handle on first use.
   *
   * With `options.pixels`, masked viewport pixels are captured alongside the
   * tree rather than after it, so the image and the node geometry describe the
   * page as closely in time as two engine calls can.
   */
  observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    // A capture that lost its document to a navigation reads as a stale node:
    // nothing was dispatched, so the runner re-observes the new document
    // within the same deadline instead of failing the call.
    return this.guard(
      operation,
      'observe',
      (currentOperation) => this.readingTab(() => this.captureObservation(currentOperation, options)),
      navigationStaleOr,
    );
  }

  /** Captures privately in the session's turn, then publishes only into the page and ref generation that requested it. */
  private captureObservation(
    operation: OperationContext,
    options: EngineObserveOptions | undefined,
  ): Promise<EngineSnapshot> {
    const session = this.requireSession();
    return session.observeInTurn(operation, (turn) => this.captureInTurn(session, turn, options));
  }

  /** One observation that holds the session's turn. */
  private async captureInTurn(
    session: AttemptSession,
    operation: OperationContext,
    options: EngineObserveOptions | undefined,
  ): Promise<EngineSnapshot> {
    const token = session.token();
    const refs = session.refs;
    const page = this.requirePage();
    const capture = refs.beginCapture();
    const captured = await captureObservation(page, refs, {
      testIdAttribute: this.testIdAttribute, site: this.app.site,
    }, operation, options);
    const { snapshot, generation } = captured;
    try {
      if (operation.signal.aborted) throw cancelled('observe cancelled');
      session.check(token);
      if (this.requirePage() !== page) {
        throw new EngineError('NODE_STALE', 'observation page was replaced', { retryable: true });
      }
      refs.publish(capture, captured);
      session.observedGeneration(token);
      return withTabs(snapshot, session);
    } catch (cause) {
      RefRegistry.dispose(generation);
      throw cause;
    }
  }
}

/** The snapshot with the attempt's tabs, when more than one is open; the snapshot as is otherwise. */
function withTabs(snapshot: EngineSnapshot, session: AttemptSession): EngineSnapshot {
  const tabs = session.openTabs();
  const shown = session.shownTab();
  const active = shown === undefined ? -1 : tabs.indexOf(shown);
  return tabs.length < 2 || active === -1 ? snapshot : { ...snapshot, tabs: { count: tabs.length, active } };
}

/**
 * How long a screenshot or a page call waits for the navigation event after Playwright has
 * already reported the document's context destroyed. The event is the commit
 * that destroyed the context, queued behind the capture's rejection.
 */
const NAVIGATION_EVENT_GRACE_MS = 250;

/** Watches `page` until `stop` for a frame that commits a new document or detaches, either of which replaces a document a capture is reading. */
function watchDocuments(page: Page): {
  readonly replaced: () => boolean;
  readonly stop: () => void;
  /** Resolves when a document has been replaced, or after `timeoutMs` if none was. */
  readonly whenReplaced: (timeoutMs: number) => Promise<void>;
} {
  let replaced = false;
  let notify: (() => void) | undefined;
  const mark = (): void => {
    replaced = true;
    notify?.();
  };
  page.on('framenavigated', mark);
  page.on('framedetached', mark);
  return {
    replaced: () => replaced,
    whenReplaced: (timeoutMs) => {
      if (replaced || timeoutMs <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        notify = done;
        function done(): void {
          clearTimeout(timer);
          notify = undefined;
          resolve();
        }
      });
    },
    stop: () => {
      page.off('framenavigated', mark);
      page.off('framedetached', mark);
    },
  };
}

/** The frame a request belongs to; undefined for a popup's first navigation, which Playwright issues before the popup's frame exists. */
function frameOf(request: Request): Frame | undefined {
  try {
    return request.frame();
  } catch {
    return undefined;
  }
}

type Rect = NonNullable<SemanticNode['rect']>;

/**
 * A located node in the top-level viewport's space, as the observation tree
 * reports it: its box shifted by the frame's and clipped to it, and dropped
 * when the frame has no box or the node lies outside it.
 */
function inFrame(node: SemanticNode, frame: Rect | null | undefined): SemanticNode {
  if (frame === undefined || node.rect === undefined) return node;
  const { rect, origin, ...rest } = node;
  return frame === null ? rest : { ...rest, ...placeBoxInFrame(rect, origin, frame) };
}

/**
 * The in-page half of `viewportIntersection`: one `IntersectionObserver`
 * callback, which reports the element's first intersection right after it
 * is observed. The empty animation frame makes Firefox deliver it. The
 * callback's own entry decides: an element the page replaced before it
 * fired is stale, and its box and ratio come from that one frame, since a
 * zero-area target that intersects reports a ratio of 1.
 */
function measureViewportIntersection(element: Element): Promise<ViewportIntersection | 'detached' | 'unsupported'> {
  if (!element.isConnected) return Promise.resolve('detached');
  if (element.getClientRects().length === 0) return Promise.resolve({ intersects: false, ratio: 0 });
  const view = element.ownerDocument.defaultView;
  if (view === null || typeof view.IntersectionObserver !== 'function') return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    const observer = new view.IntersectionObserver((entries) => {
      observer.disconnect();
      if (!element.isConnected) {
        resolve('detached');
        return;
      }
      const entry = entries.at(-1);
      const box = entry?.boundingClientRect;
      if (entry === undefined || box === undefined || box.width <= 0 || box.height <= 0) {
        resolve({ intersects: false, ratio: 0 });
        return;
      }
      // Clamped: a browser can round a fully visible box a hair past 1.
      const ratio = Math.min(1, Math.max(0, entry.intersectionRatio));
      resolve({ intersects: ratio > 0, ratio });
    });
    observer.observe(element);
    // The native frame: under Playwright's clock, the page's own would queue a timer in the page's fake clock.
    // oxlint-disable-next-line no-underscore-dangle -- Playwright's name for its page clock, which keeps the native timers
    ((view as ClockHost).__pwClock?.builtins ?? view).requestAnimationFrame(() => {});
  });
}
