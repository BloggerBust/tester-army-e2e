/**
 * The `browser` fixture: the browser-shaped deterministic surface this engine
 * contributes. It lives here, not in core, because the harness knows the
 * engine contract and never a platform's fixture shape. Every async method
 * runs as a harness-recorded `browser.<method>` step; `expect(browser)` reaches the
 * matchers attached through `context.expectable`.
 *
 * Layering rule: validation (`resolveUrl`, JSON checks, cookie URLs, the
 * download trigger) runs outside `surface.guard`, so a runner error keeps its
 * classification and only Playwright faults are translated. The URL rule is
 * never re-implemented here: `context.app.resolveUrl` is the one place that
 * says which URLs a test may open.
 */

import type { Download, Request, Response, Route } from 'playwright-core';
import type { ActionOptions, Expectable, JsonValue, Locator, Screen, TextMatch, WebResponse } from '@e2e-dev/core';
import {
  Deadline,
  describePattern,
  EngineError,
  matchesText,
  obj,
  pollCondition,
  raceAbort,
  stepTimeout,
  rejectUnknownOptions,
  TestError,
  toTextPattern,
  urlMatches,
  validateJsonValue,
  withTimeout,
  type EngineFixtureContext,
  type FixtureOperation,
  type FixtureOperations,
  type LocatorExpression,
  type OperationContext,
} from '@e2e-dev/core/engine';
import { classifyInputError } from './actions.ts';
import {
  clockInstallLabel,
  clockTicks,
  clockTicksLabel,
  clockTime,
  clockTimeLabel,
  pausedInThePast,
  translateClockError,
  type BrowserClock,
  type ClockCall,
} from './clock.ts';
import { cookieUrlsLabel, resolveCookieUrl, resolveCookieUrls, validateCookies } from './cookies.ts';
import type { AttemptTab } from './attempt-session.ts';
import type { DialogHandler } from './dialogs.ts';
import { saveDownloadsTo, saveFromBrowser, saveLocally } from './downloads.ts';
import { isTestErrorCode, message as causeMessage, pageScriptFailure, translatePwError } from './support.ts';
import { compileEvaluation, decodeEvaluation, pageFunctionSource } from './evaluation.ts';
import { initScriptLabel, testInitScriptSource } from './init-scripts.ts';
import { MEDIA_KEYS, mediaLabel, mediaProblem, type WebMedia } from './media.ts';
import { lowercaseNames } from './protected-app.ts';
import { parseContinue, parseFulfill, requireNoArguments } from './route-options.ts';
import {
  patternLabel,
  routeMethodMatches,
  routePatternsEqual,
  toRoutePattern,
  toWaitPattern,
  type NormalizedRoutePattern,
} from './route-pattern.ts';
import { describeExpectedUrl, urlPattern } from './url-glob.ts';
import type { BrowserName } from './browser-connection.ts';
import type { PlaywrightSurface } from './surface.ts';
import { createWebMcp, type WebMcp } from './webmcp.ts';

/**
 * One of `json`, `body`, or `path`, or none for an empty body. `path` names a
 * file relative to the project root; its `Content-Type` follows its
 * extension unless `contentType` or a `content-type` header sets one.
 */
export type RouteFulfillResponse = {
  status?: number;
  /** Response headers; `set-cookie` may join several cookies with `\n`, as `route.fetch()` reports them. */
  headers?: Record<string, string>;
  /** Sets the `Content-Type` response header. */
  contentType?: string;
} & (
  | { json: JsonValue; body?: never; path?: never }
  | { body: string | Uint8Array; json?: never; path?: never }
  | { path: string; json?: never; body?: never }
  | { body?: never; json?: never; path?: never }
);

/** What `continue` changes about the request before it goes to the network. */
export interface RouteContinueOverrides {
  /** Resolved against the base URL like `goto`; must keep the request's scheme. */
  url?: string;
  /** Request method. */
  method?: string;
  /** Replaces every request header; `undefined` drops one, and the configured `headers` for an allowed origin are added on top. */
  headers?: Record<string, string | undefined>;
  /** Request body. */
  postData?: string;
}

/** A request the page made: what a route handler reads as `route.request` and `waitForRequest` returns. */
export interface WebRequest {
  /** Request URL. */
  readonly url: string;
  /** HTTP method, as the page sent it. */
  readonly method: string;
  /**
   * Request headers, lower-cased names. The cookie headers the browser adds
   * on its own are there only when a route intercepts the request, so always
   * in `route.request`.
   */
  readonly headers: Readonly<Record<string, string>>;
  /** Request body as text; absent when the request has none. */
  readonly postData?: string;
}

/** What `waitForResponse` returns and its predicate reads: a `WebResponse` and the request it answers. */
export interface PageResponse extends WebResponse {
  /** The request this response answers. */
  readonly request: WebRequest;
}

export interface WebRoute {
  /** The intercepted request. */
  readonly request: WebRequest;
  /** Reads the upstream response without deciding the route or following redirects. */
  fetch(): Promise<WebResponse>;
  /** Fulfills the intercepted request once. */
  fulfill(response: RouteFulfillResponse): Promise<void>;
  /** Sends the intercepted request to the network once, skipping every other route. */
  continue(overrides?: RouteContinueOverrides): Promise<void>;
  /** Hands the intercepted request to the route registered before this one, or the network when none matches. */
  fallback(): Promise<void>;
  /** Aborts the intercepted request once. */
  abort(): Promise<void>;
}

/** A URL pattern narrowed to one HTTP method. */
export interface RouteMatcher {
  /** The HTTP method to match, case-insensitive: `'POST'` and `'post'` are the same. */
  readonly method: string;
  /**
   * The URL pattern: a string using the same grammar as a plain `route`
   * pattern, or a `RegExp`. `route`, `waitForResponse`, and `waitForRequest`
   * match requests against it; `unroute` compares it structurally.
   */
  readonly url: string | RegExp;
}

/** The response type `request` returns too, defined in core so the shapes cannot drift. */
export type { WebResponse } from '@e2e-dev/core';

/**
 * Reads the body once the response is known and keeps the outcome: a body
 * that arrived returns a copy of its bytes on every call, a body the browser could not
 * read rejects every call with `ACTION_FAILED` naming the cause. Swallowing
 * that failure would hand the test an empty string the server never sent,
 * indistinguishable from a real empty body. `failure` names the reason the
 * browser reported on a page request (`net::ERR_CONTENT_LENGTH_MISMATCH` for
 * a connection cut short of the declared length, `net::ERR_ABORTED` for a
 * request the page aborted), and the error behind the read is the fallback,
 * as for a redirect, whose body the browser never keeps.
 */
async function readResponseBody(
  api: 'waitForResponse' | 'route.fetch',
  body: () => Promise<Buffer>,
  failure: () => string | undefined = () => undefined,
): Promise<() => Promise<Buffer>> {
  try {
    const bytes = await body();
    return () => Promise.resolve(Buffer.from(bytes));
  } catch (cause) {
    const error = new TestError(
      'ACTION_FAILED',
      `${api}: response body could not be read: ${failure() ?? causeMessage(cause)}`,
    );
    return () => Promise.reject(error);
  }
}

/** The `WebRequest` over a Playwright request: one reading for route handlers and `waitForRequest`, so the two cannot drift. */
function webRequest(request: Request): WebRequest {
  const postData = request.postData();
  return {
    url: request.url(),
    method: request.method(),
    headers: request.headers(),
    ...(postData === null ? {} : { postData }),
  };
}

/**
 * Keeps the failure of a test's wait predicate away from Playwright: its
 * waiter rewrites the message of whatever the predicate throws, in place,
 * and fails on a thrown non-`Error`. `call` throws a stand-in that remembers
 * the cause, and `translate`, given to `surface.guard`, throws that cause
 * untranslated, so an `expect` in a predicate keeps `ASSERTION_FAILED` and a
 * plain throw reads as the test's own `ERROR`, never `ENGINE_FAILURE`. Only
 * the rejection that ended the wait is translated, so a predicate that fails
 * after a timeout cannot replace it.
 */
function predicateFailures() {
  const causes = new WeakMap<Error, { readonly cause: unknown }>();
  return {
    async call<T>(predicate: (candidate: T) => unknown, candidate: T): Promise<boolean> {
      try {
        return Boolean(await predicate(candidate));
      } catch (cause) {
        const standIn = new Error('wait predicate failed');
        causes.set(standIn, { cause });
        throw standIn;
      }
    },
    translate(cause: unknown, label: string): Error {
      const failure = cause instanceof Error ? causes.get(cause) : undefined;
      if (failure !== undefined) throw failure.cause;
      return translatePwError(cause, label);
    },
  };
}

type PredicateFailures = ReturnType<typeof predicateFailures>;

/** Memoizes `make` per candidate, so the view a wait predicate saw is the one the wait returns. */
function viewOnce<Candidate extends object, View>(make: (candidate: Candidate) => View): (candidate: Candidate) => View {
  const views = new WeakMap<Candidate, View>();
  return (candidate) => {
    let view = views.get(candidate);
    if (view === undefined) {
      view = make(candidate);
      views.set(candidate, view);
    }
    return view;
  };
}

/** The `WebResponse` over a Playwright response's metadata and a reader for its body bytes. */
function webResponse(
  response: { url(): string; status(): number; headers(): Record<string, string> },
  body: () => Promise<Buffer>,
): WebResponse {
  const text = async (): Promise<string> => new TextDecoder().decode(await body());
  return {
    url: response.url(),
    status: response.status(),
    headers: response.headers(),
    body,
    // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
    json: async <T = unknown>() => JSON.parse(await text()) as T,
    text,
  };
}

export interface CookieFields {
  /** Cookie name. */
  name: string;
  /** Cookie value. */
  value: string;
  /** Unix timestamp in whole seconds. */
  expires?: number;
  /** HttpOnly flag. */
  httpOnly?: boolean;
  /** Secure flag. */
  secure?: boolean;
  /** SameSite attribute. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** `url`, or `domain` with an optional `path`, never both. */
export type Cookie = CookieFields &
  (
    | { url: string; domain?: never; path?: never }
    | { url?: never; domain: string; path?: string }
  );

/** Cookie filters are combined; strings match exactly, RegExp matches the field. */
export interface CookieFilter {
  name?: string | RegExp;
  domain?: string | RegExp;
  path?: string | RegExp;
}

export interface BrowserExpectation {
  /** Inverts the matcher. */
  readonly not: BrowserExpectation;
  /** Waits for the current URL to match; `ignoreCase` compares a string case-insensitively and adds the `i` flag to a RegExp, `false` removes it. */
  toHaveURL(expected: string | RegExp, options?: { ignoreCase?: boolean; timeout?: number }): Promise<void>;
  /** Waits for the current title to match. */
  toHaveTitle(expected: TextMatch, options?: { timeout?: number }): Promise<void>;
  /** Waits for the target's `class` attribute to match: a string is the whole normalized class list, a RegExp is tested against it. */
  toHaveClass(target: Locator, expected: TextMatch, options?: { timeout?: number }): Promise<void>;
}

/**
 * The screen scope `browser.frameLocator` returns. Every `Screen` query answers
 * from inside the frame, and because the frame's document is Playwright's,
 * the web-only escape hatches follow it in: `locator` for a CSS or XPath
 * selector on a control with no accessible name, `frameLocator` for a frame
 * nested inside this one.
 */
export interface FrameScreen extends Screen {
  /** Creates a web-only CSS or XPath locator inside this frame. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside an iframe nested in this frame. */
  frameLocator(selector: string): FrameScreen;
}

/**
 * One tab of the browser the attempt drives: the attempt's own, one the app
 * opened, or one `browser.newTab` opened. The same tab is the same object for
 * the whole attempt.
 */
export interface BrowserTab {
  /** Returns the tab's current URL. */
  url(): Promise<string>;
  /** Returns the tab's current title. */
  title(): Promise<string>;
  /** Whether this is the active tab, the one `screen`, `expect`, and the browser's page methods act on. */
  isActive(): boolean;
  /** Whether the tab has closed. */
  isClosed(): boolean;
  /** Makes this the active tab. Rejects with `ACTION_FAILED` when it has closed. */
  activate(): Promise<void>;
  /**
   * Closes the tab. When it was the active tab, the tab that opened it becomes
   * active, else the open tab that was active most recently.
   */
  close(): Promise<void>;
}

/**
 * The browser the attempt drives, showing one active tab. Navigation, reads,
 * `locator`, `frameLocator`, `evaluate`, `waitForResponse`, `waitForRequest`,
 * `waitForDownload`, the keyboard and mouse, `expect(browser)`, and `screen` act on the active
 * tab; cookies, routes, and dialog handlers cover the whole browser, every
 * tab included. A tab the app opens (a `target="_blank"` link,
 * `window.open`) joins `tabs()` but does not become active on its own:
 * `waitForPopup` makes the tab its trigger opens active, and `activate`
 * any other. When the active tab closes, the tab that opened it is active
 * again.
 */
export interface Browser extends Expectable<BrowserExpectation> {
  /**
   * The browser the attempt drives, as the driver names it: the
   * `web({ browser })` value, and `chromium` for every browser the engine
   * attaches to over CDP (`connect`, a provider), whatever it is.
   */
  readonly name: BrowserName;
  /**
   * The version the running browser reports, such as `159.0.8154.6`: for
   * an attached or hosted one, what its CDP endpoint reports. The target's
   * `userAgent` does not change it.
   */
  readonly version: string;
  /** Navigates to an allowed URL. */
  goto(
    url: string,
    options?: {
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
      timeout?: number;
    },
  ): Promise<void>;
  /** Reloads the current document. */
  reload(options?: ActionOptions): Promise<void>;
  /** Navigates browser history back once. */
  back(options?: ActionOptions): Promise<void>;
  /** Navigates browser history forward once. */
  forward(options?: ActionOptions): Promise<void>;
  /** Returns the current URL. */
  url(): Promise<string>;
  /** Returns the current title. */
  title(): Promise<string>;
  /** Waits for the current URL to match. */
  waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  /** Creates a web-only CSS or XPath locator. */
  locator(selector: string): Locator;
  /** Creates a screen query scope inside one iframe. */
  frameLocator(selector: string): FrameScreen;
  /** Evaluates trusted test code in the page: a function, or a string expression whose value is returned, called first if it is a function. */
  evaluate<T extends JsonValue>(fn: string | (() => T | Promise<T>)): Promise<T>;
  /** Evaluates trusted test code with one required JSON-safe argument. */
  evaluate<T extends JsonValue, Arg extends JsonValue>(
    fn: string | ((arg: Arg) => T | Promise<T>),
    arg: Arg,
  ): Promise<T>;
  /**
   * Adds a script every document runs before the page's own, from the next
   * navigation on: JavaScript source, a `{ path }` relative to the project
   * root, or a function.
   */
  addInitScript(script: string | { path: string } | (() => unknown)): Promise<void>;
  /** Adds an init script function called with one JSON argument. */
  addInitScript<Arg extends JsonValue>(script: (arg: Arg) => unknown, arg: Arg): Promise<void>;
  /** Adds an attempt-scoped network route, optionally narrowed to one HTTP method. */
  route(
    pattern: string | RegExp | RouteMatcher,
    handler: (route: WebRoute) => void | Promise<void>,
  ): Promise<void>;
  /**
   * Removes the routes registered with the same pattern: the same string or
   * `RegExp` source and flags, and the same method for a `{ method, url }`
   * pattern. It does not URL-match registered routes.
   */
  unroute(pattern: string | RegExp | RouteMatcher): Promise<void>;
  /** Removes all routes registered by this browser fixture, preserving the configured headers. */
  unrouteAll(): Promise<void>;
  /**
   * Waits for a response on the active tab matching a URL pattern, a
   * `{ method, url }` matcher, or a predicate. The predicate runs per response
   * until one returns or resolves to a truthy value; throwing fails the wait
   * with the predicate's own error.
   */
  waitForResponse(
    pattern: string | RegExp | RouteMatcher | ((response: PageResponse) => boolean | Promise<boolean>),
    options?: { timeout?: number },
  ): Promise<PageResponse>;
  /**
   * Waits for a request on the active tab matching a URL pattern, a
   * `{ method, url }` matcher, or a predicate, and resolves when the page sends
   * it before any response arrives. Predicate matching and errors work the
   * same way as in `waitForResponse`.
   */
  waitForRequest(
    pattern: string | RegExp | RouteMatcher | ((request: WebRequest) => boolean | Promise<boolean>),
    options?: { timeout?: number },
  ): Promise<WebRequest>;
  /**
   * Returns every cookie of the browser, or only those a request to `urls`
   * (one URL or several) would carry. A relative URL resolves against the
   * base URL.
   */
  cookies(urls?: string | readonly string[]): Promise<Cookie[]>;
  /** Sets cookies after URL validation. */
  setCookies(cookies: readonly Cookie[]): Promise<void>;
  /** Removes matching cookies only; without filters removes every cookie, preserving other storage. */
  clearCookies(options?: CookieFilter): Promise<void>;
  /** Sets the viewport size. */
  setViewport(size: { width: number; height: number }): Promise<void>;
  /**
   * Emulates CSS media features on every open tab and every tab opened after
   * them, the app's own included, for the rest of the attempt, as Playwright's
   * `page.emulateMedia` does: the page's `@media` rules and `matchMedia` both
   * read them. A feature left out keeps its value. Works before the first
   * navigation, so the page loads with them.
   */
  emulateMedia(media: WebMedia): Promise<void>;
  /**
   * Takes the browser offline or back online for the rest of the attempt:
   * every tab, every tab opened after, and the page's service workers.
   * Offline, a request that reaches the network fails as it does with no
   * connection, and `navigator.onLine` is `false`. A service worker can
   * still answer from its cache. Every attempt starts online.
   */
  setNetwork(state: 'online' | 'offline'): Promise<void>;
  /** Registers an attempt-scoped dialog handler and returns an unsubscribe function. */
  onDialog(handler: DialogHandler): Promise<() => Promise<void>>;
  /** Returns the open tabs, in the order they opened. */
  tabs(): readonly BrowserTab[];
  /**
   * Runs a trigger and waits for the tab it opens, then resolves with that
   * tab once it is the active tab. The wait takes the first tab the app
   * opens after it starts, which can be one an earlier action opened whose
   * page loaded only now. Rejects with `ACTION_FAILED` when no tab opens
   * within the timeout, naming the page when a tab was still loading it.
   */
  waitForPopup(trigger: () => Promise<void>, options?: { timeout?: number }): Promise<BrowserTab>;
  /** Opens a blank tab in the same browser context, sharing its cookies and storage, and makes it the active tab. */
  newTab(): Promise<BrowserTab>;
  /** Runs a trigger and waits for its download. */
  waitForDownload(
    trigger: () => Promise<void>,
    options?: { timeout?: number },
  ): Promise<{ path: string; absolutePath: string; suggestedFilename: string }>;
  /** Runs one trigger and waits for the requested number of completed downloads. */
  waitForDownloads(
    trigger: () => Promise<void>,
    options: { count: number; timeout?: number },
  ): Promise<readonly { path: string; absolutePath: string; suggestedFilename: string }[]>;
  /** Viewport-level keyboard, for whatever has focus. */
  readonly keyboard: {
    /** Sends one key. */
    press(key: string): Promise<void>;
    /** Holds one key until up; repeated down calls send a repeat event. */
    down(key: string): Promise<void>;
    /** Releases a held key. */
    up(key: string): Promise<void>;
    /** Types plain text. */
    type(text: string): Promise<void>;
  };
  /**
   * Direct pointer input from test code, independent of agent observations.
   * After CDP recovery, test code can read current geometry with `evaluate`
   * before starting a pointer sequence.
   */
  readonly mouse: {
    /** Moves the pointer. */
    move(x: number, y: number): Promise<void>;
    /** Scrolls the pointer wheel. */
    wheel(deltaX: number, deltaY: number): Promise<void>;
    /** Presses the primary pointer button. */
    down(): Promise<void>;
    /** Releases the primary pointer button. */
    up(): Promise<void>;
  };
  /**
   * The tools the active tab's page registers through WebMCP
   * (`document.modelContext`, `navigator.modelContext` on Firefox), read and
   * called from test code with no model involved. It covers the page's main
   * frame. Needs a browser with WebMCP: `web({ webmcp: true })`, or
   * `--enable-features=WebMCP` on a browser the engine attaches to, and a
   * page in a secure context; on a page without WebMCP both calls reject with
   * `UNSUPPORTED_CAPABILITY`. Names, descriptions, schemas, and results come
   * from the page, so treat them as untrusted input.
   */
  readonly webmcp: WebMcp;
  /**
   * Controls time in the attempt's pages, as Playwright's `page.clock` does:
   * `Date`, timers, and `requestAnimationFrame` in every tab and frame, the
   * ones the app opens included. It covers the whole browser, survives
   * navigation, `app.restart()`, and `app.clearState()`, and ends with the
   * attempt.
   */
  readonly clock: BrowserClock;
}

interface StoredRoute {
  readonly pattern: NormalizedRoutePattern;
  readonly pwHandler: (route: Route) => Promise<void>;
  readonly predicate: (url: URL) => boolean;
}

/** A saved download as `waitForDownload` and `waitForDownloads` return it. */
type DownloadedFile = { path: string; absolutePath: string; suggestedFilename: string };

/**
 * Runs `trigger` once and saves the first `count` downloads it starts, in
 * start order, each attached as a `download` artifact. One budget bounds the
 * start, completion and save of every file; on failure the unfinished
 * downloads are canceled and nothing is attached after it.
 */
async function collectDownloads(
  surface: PlaywrightSurface,
  context: EngineFixtureContext,
  trigger: () => Promise<void>,
  count: number,
  timeout: number | undefined,
  api: 'browser.waitForDownload' | 'browser.waitForDownloads',
): Promise<DownloadedFile[]> {
  const operation = context.operation(stepTimeout(timeout, api));
  const waitMs = operation.timeoutMs;
  const deadline = new Deadline(waitMs);
  const scope = new AbortController();
  const signal = AbortSignal.any([operation.signal, scope.signal]);
  const started: Download[] = [];
  let triggerFailure: { cause: unknown } | undefined;
  let triggerMs: number | undefined;
  let finished = false;
  let stopListening = (): void => {};
  const timedOut = (): TestError => new TestError(
    'ACTION_FAILED',
    triggerMs === undefined
      ? `${api} exceeded its timeout of ${waitMs}ms`
      : started.length < count
        ? `${count === 1 ? 'no download' : `${started.length} of ${count} downloads`} started within ${waitMs}ms; the trigger resolved after ${triggerMs}ms`
        : `${count === 1 ? 'the download' : `${count} downloads`} did not finish within ${waitMs}ms`,
  );
  const requireOpen = (): void => {
    if (scope.signal.aborted || deadline.expired()) throw timedOut();
  };
  try {
    return await withTimeout(surface.guard({ ...operation, signal }, 'download', async (currentOperation) => {
      requireOpen();
      const page = surface.requirePage();
      const remote = surface.remoteDownloads();
      if (remote !== undefined) await saveDownloadsTo(page, remote.dir, currentOperation.signal);
      requireOpen();
      let allStarted!: () => void;
      const received = new Promise<void>((resolve) => { allStarted = resolve; });
      const onDownload = (download: Download): void => {
        if (scope.signal.aborted || started.length === count) return;
        started.push(download);
        if (started.length === count) allStarted();
      };
      stopListening = () => { page.off('download', onDownload); };
      page.on('download', onDownload);
      const triggerStart = Date.now();
      try {
        await trigger();
      } catch (cause) {
        triggerFailure = { cause };
        throw cause;
      }
      triggerMs = Date.now() - triggerStart;
      await raceAbort(received, currentOperation.signal, 'download');
      const files: DownloadedFile[] = [];
      for (const download of started) {
        const suggestedFilename = download.suggestedFilename();
        const { relative, absolute } = surface.artifactPath('downloads', suggestedFilename, '');
        if (remote === undefined) await saveLocally(download, absolute, surface.unservedDownloads());
        else await saveFromBrowser(download, remote, absolute, currentOperation.signal);
        if (currentOperation.signal.aborted) throw timedOut();
        context.attachArtifact('download', relative);
        files.push({ path: relative, absolutePath: absolute, suggestedFilename });
      }
      finished = true;
      return files;
    }, (cause, label) => {
      // The trigger is test code, so its errors keep their original classification.
      if (triggerFailure !== undefined && Object.is(cause, triggerFailure.cause)) throw cause;
      return translatePwError(cause, label);
    }, 'test-code'), deadline.remaining(), timedOut);
  } finally {
    // The owner closes even when a trigger never settles; late work cannot attach artifacts.
    scope.abort();
    stopListening();
    if (!finished) {
      for (const download of started) void download.cancel().catch(() => undefined);
    }
  }
}

/**
 * Runs a trigger and waits for the tab it opens to become the active one.
 * The trigger is test code, so its errors keep their classification; the
 * wait for the tab is bounded apart from it. A timeout names the page a tab
 * was still loading, if any, as such a tab has no page to show yet.
 */
async function waitForTab(
  surface: PlaywrightSurface,
  context: EngineFixtureContext,
  trigger: () => Promise<void>,
  timeout: number | undefined,
): Promise<AttemptTab> {
  const api = 'browser.waitForPopup';
  const operation = context.operation(stepTimeout(timeout, api));
  const waitMs = operation.timeoutMs;
  const deadline = new Deadline(waitMs);
  const scope = new AbortController();
  let triggerFailure: { cause: unknown } | undefined;
  let triggerMs: number | undefined;
  let loading = (): string | undefined => undefined;
  const timedOut = (): TestError => {
    const url = loading();
    if (url !== undefined) return new TestError('ACTION_FAILED', `the tab the app opened did not load ${url} within ${waitMs}ms`);
    return new TestError(
      'ACTION_FAILED',
      triggerMs === undefined
        ? `${api} exceeded its timeout of ${waitMs}ms`
        : `no tab opened within ${waitMs}ms; the trigger resolved after ${triggerMs}ms`,
    );
  };
  try {
    return await withTimeout(surface.guard({ ...operation, signal: AbortSignal.any([operation.signal, scope.signal]) }, 'popup', async (current) => {
      const popup = surface.nextPopup(current.signal);
      ({ loading } = popup);
      const { opened } = popup;
      opened.catch(() => undefined);
      const triggerStart = Date.now();
      try {
        await trigger();
      } catch (cause) {
        triggerFailure = { cause };
        throw cause;
      }
      triggerMs = Date.now() - triggerStart;
      return await opened;
    }, (cause, label) => {
      // The trigger is test code, so its errors keep their original classification.
      if (triggerFailure !== undefined && Object.is(cause, triggerFailure.cause)) throw cause;
      return translatePwError(cause, label);
    }, 'test-code'), deadline.remaining(), timedOut);
  } finally {
    scope.abort();
  }
}

/** Builds the `browser` fixture for one attempt over the shared surface. */
export function createBrowserFixture(surface: PlaywrightSurface, context: EngineFixtureContext): Browser {
  const latch = surface.latch;
  const routes: StoredRoute[] = [];
  /** One handle per tab, so the same tab is the same object for the attempt. */
  const tabHandles = new WeakMap<AttemptTab, BrowserTab>();
  const tabAction: FixtureOperation = { kind: 'resource' };
  /** The handle a test holds for one of the attempt's tabs. */
  const tabHandle = (tab: AttemptTab): BrowserTab => {
    const known = tabHandles.get(tab);
    if (known !== undefined) return known;
    const handle = context.fixture<BrowserTab>('tab', {
      url: () => surface.guard(context.operation(), 'url', async () => tab.page.url()),
      title: () => surface.guard(context.operation(), 'title', () => tab.page.title()),
      isActive: () => surface.shownTab() === tab,
      isClosed: () => tab.page.isClosed(),
      activate: () => surface.showTab(tab, context.operation()),
      close: () => surface.closeTab(tab, context.operation()),
    }, { url: tabAction, title: tabAction, activate: tabAction, close: tabAction });
    tabHandles.set(tab, handle);
    return handle;
  };

  /**
   * Runs one checked clock call as the step's operation. `pauseAt` is
   * compared with the page clock first: Playwright logs a call for the next
   * documents before it runs it, so a time it refused would still move them.
   */
  const runClock = (call: ClockCall): Promise<void> => {
    const label = `browser.clock.${call.method}`;
    return surface.guard(context.operation(), label, async () => {
      if (call.method === 'pauseAt' && call.ms < ((await surface.clockNow()) ?? -Infinity)) throw pausedInThePast(label);
      await surface.clock(call);
    }, (cause) => translateClockError(cause, label, call.method));
  };

  /** Unregisters the stored routes `match` selects, newest first. */
  const removeRoutes = async (match: (stored: StoredRoute) => boolean): Promise<void> => {
    for (let i = routes.length - 1; i >= 0; i -= 1) {
      const stored = routes[i]!;
      if (!match(stored)) continue;
      await surface.unroute(stored.predicate, stored.pwHandler);
      routes.splice(i, 1);
    }
  };

  /**
   * Relative URLs and URL matching need the configured base. Resolving the
   * empty reference yields the base itself, and lets the harness raise
   * `APP_URL_REQUIRED` when there is none.
   */
  const baseHref = (): string => context.app.resolveUrl('');

  /**
   * A navigation's budget: the call's own timeout, else the test timeout the
   * harness gives `app.open` - a document load is not an action and must not
   * be cut at the action timeout.
   */
  const navigation = (
    api: string,
    options: { timeout?: number } | undefined,
    run: (operation: OperationContext) => Promise<void>,
  ): Promise<void> => {
    const operation = context.operation(stepTimeout(options?.timeout, api) ?? context.timeouts.test);
    return surface.guard(operation, 'navigation', run);
  };

  /** An assertion-style budget: the given timeout or the assertion timeout, clamped to the test. */
  const deadlineFor = (timeout: number | undefined, api: string): Deadline =>
    new Deadline(context.operation(stepTimeout(timeout, api) ?? context.timeouts.assertion).timeoutMs);

  /** The page URL, read within the action timeout or, for a matcher poll, within the poll's deadline. */
  const currentUrl = (deadline?: Deadline) =>
    surface.guard(context.operation(deadline?.remaining()), 'url', async () => surface.requirePage().url());
  /** The page title, read within the action timeout or, for a matcher poll, within the poll's deadline. */
  const currentTitle = (deadline?: Deadline) =>
    surface.guard(context.operation(deadline?.remaining()), 'title', () => surface.requirePage().title());
  /**
   * What Playwright's waiter calls with each candidate of `waitForResponse`
   * or `waitForRequest`: the test's predicate over the candidate's view, or
   * the route pattern over its request's URL and method. The pattern compiles
   * here, before the wait, so an invalid glob fails before anything waits.
   */
  const waitMatcher = <Candidate, View>(
    wanted: NormalizedRoutePattern | ((view: View) => unknown),
    requestOf: (candidate: Candidate) => Request,
    failures: PredicateFailures,
  ): ((view: (candidate: Candidate) => View) => (candidate: Candidate) => boolean | Promise<boolean>) => {
    if (typeof wanted === 'function') return (view) => (candidate) => failures.call(wanted, view(candidate));
    const { matches } = urlPattern(wanted.url, baseHref);
    return () => (candidate) => {
      const request = requestOf(candidate);
      return matches(request.url()) && routeMethodMatches(wanted, request.method());
    };
  };

  /**
   * The `PageResponse` over one response a wait saw. Its body is read once,
   * when first asked for. While the wait runs, a read is bounded by
   * `waitSignal` only, since the wait's own timeout already bounds a predicate
   * that reads it; a read still pending when the wait ends is cancelled with
   * it, unless its response is the one the wait returns. `settle` starts
   * reading that response at once, while the browser still holds the body. A
   * read that starts after the wait, on any response it saw, and a read of the
   * returned response the predicate left pending, wait on a budget of their
   * own: the timeout bounds the match, never a body still streaming in behind
   * headers that already arrived.
   */
  const responseView = (response: Response, waitSignal: AbortSignal) => {
    let started: Promise<() => Promise<Buffer>> | undefined;
    let settled = false;
    const start = () =>
      (started ??= readResponseBody('waitForResponse', () => response.body(), () => response.request().failure()?.errorText));
    const read = async (): Promise<Buffer> => {
      if (!settled && !waitSignal.aborted) {
        const inWait = await raceAbort(start(), waitSignal, 'waitForResponse body').catch((cause: unknown) => {
          // The wait returned this response while the read was pending: it goes on as a read of that response.
          if (settled) return undefined;
          throw cause;
        });
        if (inWait) return inWait();
      }
      const { signal, timeoutMs } = context.operation();
      const bytes = await raceAbort(
        withTimeout(start(), timeoutMs, () =>
          new TestError('ACTION_FAILED', `waitForResponse: response body did not finish within ${timeoutMs}ms`)),
        signal,
        'waitForResponse body',
      );
      return bytes();
    };
    const view: PageResponse = { ...webResponse(response, read), request: webRequest(response.request()) };
    return {
      response: view,
      settle(): PageResponse {
        settled = true;
        // Never rejects: `readResponseBody` keeps a failed read for the readers.
        void start();
        return view;
      },
    };
  };

  const expectationDeps: ExpectationDeps = { currentUrl, currentTitle, baseHref, deadlineFor, context };
  const expectation = createBrowserExpectation(expectationDeps);

  const identity = surface.browserIdentity(() => context.signal);

  const browser: Omit<Browser, keyof Expectable<BrowserExpectation>> = {
    get name() {
      return identity().name;
    },
    get version() {
      return identity().version;
    },
    goto(url, options) {
      const resolved = context.app.resolveUrl(url);
      return navigation('browser.goto', options, (operation) => surface.navigating(async () => {
        const page = await surface.ensurePage();
        await page.goto(resolved, {
          waitUntil: options?.waitUntil ?? 'load',
          timeout: operation.timeoutMs,
        });
      }));
    },
    reload: (options) =>
      navigation('browser.reload', options, (operation) => surface.navigating(async () => {
        await surface.requirePage().reload({ waitUntil: 'load', timeout: operation.timeoutMs });
      })),
    back: (options) =>
      navigation('browser.back', options, (operation) => surface.navigating(async () => {
        await surface.requirePage().goBack({ waitUntil: 'load', timeout: operation.timeoutMs });
      })),
    forward: (options) =>
      navigation('browser.forward', options, (operation) => surface.navigating(async () => {
        await surface.requirePage().goForward({ waitUntil: 'load', timeout: operation.timeoutMs });
      })),
    url: () => currentUrl(),
    title: () => currentTitle(),
    waitForURL: (url, options) => {
      rejectUnknownOptions('browser.waitForURL', options, ['timeout']);
      return waitForUrl(expectationDeps, url, options?.timeout);
    },
    locator: (selector) => context.locator({ kind: 'selector', selector: requireSelector('browser.locator', selector) }),
    frameLocator: (selector) => frameScreen(context, [requireSelector('browser.frameLocator', selector)]),
    async evaluate<T extends JsonValue>(
      fn: string | ((arg?: never) => T | Promise<T>),
      arg?: JsonValue,
    ): Promise<T> {
      const source = typeof fn === 'string' ? fn : pageFunctionSource(fn);
      validateJsonValue(arg, 'evaluate argument');
      const evaluate = compileEvaluation(source, arg !== undefined);
      // JSON safety is checked above; Playwright's recursive argument type cannot expand JsonValue.
      const input: unknown = arg;
      // A handle, not a value: the boundary resolves to a string, which Playwright
      // keeps out of its in-page serializer when it is taken back from a handle.
      const report = await surface.guard(context.operation(), 'evaluate', async (operation) => {
        const page = surface.requirePage();
        try {
          const handle = await page.evaluateHandle(evaluate, input);
          return await handle.jsonValue();
        } catch (cause) {
          throw (await pageScriptFailure(page, cause, 'evaluate', operation.timeoutMs)) ?? cause;
        }
      });
      return decodeEvaluation(report) as T;
    },
    async addInitScript(script: unknown, ...rest: unknown[]) {
      const source = await testInitScriptSource(script, rest.length === 0 ? undefined : { arg: rest[0] }, (file) => surface.projectPath(file));
      await surface.guard(context.operation(), 'addInitScript', () => surface.addInitScript(source));
    },
    route(pattern, handler) {
      const wirePattern = toRoutePattern('browser.route', pattern);
      const { matches } = urlPattern(wirePattern.url, baseHref);
      const predicate = (url: URL) => matches(url.href);
      // Playwright never surfaces a throwing route handler to the test, so a
      // contract violation (no decision, two decisions) or a failing handler
      // is latched on the surface and fails the next step with its real cause.
      const handleRoute = async (route: Route): Promise<void> => {
        let decided = false;
        const request = route.request();
        // Noted before the abort, so a navigation it fails reads as aborted by the test.
        const abort = async (): Promise<void> => {
          surface.noteRouteAbort(request);
          await route.abort();
        };
        const decide = (name: string) => {
          if (decided) {
            throw new TestError('ACTION_FAILED', `route handler already decided; ${name} called twice`);
          }
          decided = true;
        };
        // Validation runs before `decide`, so a rejected option leaves the
        // request to the abort below. A Playwright call that fails after the
        // decision aborts too, rather than leaving the page's request pending.
        const decideWith = async (name: string, act: () => Promise<void>): Promise<void> => {
          decide(name);
          try {
            await act();
          } catch (cause) {
            await abort().catch(() => undefined);
            throw cause;
          }
        };
        const publicRoute: WebRoute = {
          request: webRequest(request),
          fetch: async (...args: unknown[]) => {
            requireNoArguments('route.fetch', args);
            return surface.guard(context.operation(), 'route.fetch', async currentOperation => {
              const configured = surface.configuredHeaders(request.url());
              const response = await route.fetch({
                headers: { ...lowercaseNames(request.headers()), ...configured },
                timeout: currentOperation.timeoutMs,
                maxRedirects: 0,
              });
              try {
                return webResponse(response, await readResponseBody('route.fetch', () => response.body()));
              } finally {
                await response.dispose();
              }
            });
          },
          fulfill: async (response) => {
            const decision = parseFulfill(response, (file) => surface.projectPath(file));
            await decideWith('fulfill', () => route.fulfill({
              ...decision,
              ...(decision.json === undefined && decision.path === undefined && decision.body === undefined
                ? { body: '' }
                : {}),
            }));
          },
          continue: async (overrides) => {
            const { headers, ...decision } = parseContinue(overrides, request.url(), context.app.resolveUrl);
            // `continue` skips every route registered before this one, the
            // configured-headers route included, so it merges those headers itself.
            const configured = surface.configuredHeaders(decision.url ?? request.url());
            await decideWith('continue', () => route.continue({
              ...decision,
              ...(headers === undefined && configured === undefined
                ? {}
                : { headers: { ...lowercaseNames(headers ?? request.headers()), ...configured } }),
            }));
          },
          fallback: async (...args: unknown[]) => {
            requireNoArguments('route.fallback', args);
            await decideWith('fallback', () => route.fallback());
          },
          abort: async (...args: unknown[]) => {
            requireNoArguments('route.abort', args);
            await decideWith('abort', abort);
          },
        };
        try {
          await handler(publicRoute);
          if (!decided) {
            throw new TestError(
              'ACTION_FAILED',
              'route handler returned without calling fulfill, continue, fallback, or abort',
            );
          }
        } catch (cause) {
          latch.latch(
            cause instanceof Error
              ? cause
              : new TestError('ACTION_FAILED', `route handler failed: ${causeMessage(cause)}`),
          );
          if (!decided) await abort().catch(() => undefined);
        }
      };
      // Tracked so the attempt end waits for a handler still running and
      // collects what it latched.
      const pwHandler = (route: Route): Promise<void> => {
        // A route narrowed to another method steps aside for the routes
        // registered before it, exactly as if its URL predicate had not
        // matched: the request still reaches an older route, or the network.
        if (!routeMethodMatches(wirePattern, route.request().method())) {
          // Nothing awaits a route handler; a fallback that fails because the
          // page closed under the request is dropped, as the configured
          // headers route drops its own.
          return route.fallback().catch(() => undefined);
        }
        const work = handleRoute(route);
        latch.track('route', work);
        return work;
      };
      return surface.guard(context.operation(), 'route', async () => {
        routes.push({ pattern: wirePattern, pwHandler, predicate });
        await surface.route(predicate, pwHandler);
      });
    },
    unroute(pattern) {
      const wirePattern = toRoutePattern('browser.unroute', pattern);
      return surface.guard(context.operation(), 'unroute', () =>
        removeRoutes(stored => routePatternsEqual(stored.pattern, wirePattern)));
    },
    unrouteAll() {
      return surface.guard(context.operation(), 'unrouteAll', () => removeRoutes(() => true));
    },
    waitForResponse(pattern, options) {
      rejectUnknownOptions('browser.waitForResponse', options, ['timeout']);
      const failures = predicateFailures();
      const match = waitMatcher(toWaitPattern('browser.waitForResponse', pattern), (response: Response) => response.request(), failures);
      const operation = context.operation(stepTimeout(options?.timeout, 'browser.waitForResponse'));
      return surface.guard(operation, 'waitForResponse', async (currentOperation) => {
        const page = await surface.ensurePage();
        // Ends the body reads of the responses the wait passed over once it settles,
        // so a predicate still reading one stops instead of holding it for the attempt.
        const waited = new AbortController();
        const reads = AbortSignal.any([currentOperation.signal, waited.signal]);
        try {
          const view = viewOnce((response: Response) => responseView(response, reads));
          const response = await page.waitForResponse(
            match((candidate) => view(candidate).response),
            { timeout: currentOperation.timeoutMs, signal: currentOperation.signal },
          );
          return view(response).settle();
        } finally {
          waited.abort();
        }
      }, failures.translate);
    },
    waitForRequest(pattern, options) {
      rejectUnknownOptions('browser.waitForRequest', options, ['timeout']);
      const failures = predicateFailures();
      const match = waitMatcher(toWaitPattern('browser.waitForRequest', pattern), (request: Request) => request, failures);
      const operation = context.operation(stepTimeout(options?.timeout, 'browser.waitForRequest'));
      return surface.guard(operation, 'waitForRequest', async (currentOperation) => {
        const page = await surface.ensurePage();
        const view = viewOnce(webRequest);
        const request = await page.waitForRequest(
          match(view),
          { timeout: currentOperation.timeoutMs, signal: currentOperation.signal },
        );
        return view(request);
      }, failures.translate);
    },
    cookies(urls) {
      const targets = resolveCookieUrls(urls, context.app.resolveUrl);
      return surface.guard(context.operation(), 'cookies', async () => {
        // The driver reads an empty list as no filter; a list that came out
        // empty must not widen to every site's cookies.
        const cookies = targets?.length === 0 ? [] : await surface.requireContext().cookies(targets);
        return cookies.map(
          (cookie): Cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.expires >= 0 ? { expires: Math.floor(cookie.expires) } : {}),
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          }),
        );
      });
    },
    setCookies(cookies) {
      validateCookies(cookies);
      const scheme = new URL(baseHref()).protocol === 'https:' ? 'https' : 'http';
      // The harness's URL rule decides which cookie targets are admitted; a
      // domain cookie is checked as the origin it would be sent to. The rule
      // admits `about:blank` for navigation, which holds no cookie. A `url`
      // cookie is set on the URL the rule resolved, so a relative one lands
      // on the base URL the way `goto` would.
      const targets = cookies.map((cookie) => {
        const target = resolveCookieUrl(
          cookie.url === undefined ? `${scheme}://${cookie.domain.replace(/^\./, '')}` : cookie.url,
          context.app.resolveUrl,
        );
        return cookie.url === undefined
          ? { domain: cookie.domain, path: cookie.path ?? '/' }
          : { url: target };
      });
      return surface.guard(context.operation(), 'setCookies', async () => {
        await surface.requireContext().addCookies(
          cookies.map((cookie, index) => ({
            name: cookie.name,
            value: cookie.value,
            ...targets[index]!,
            ...(cookie.expires !== undefined ? { expires: cookie.expires } : {}),
            ...(cookie.httpOnly !== undefined ? { httpOnly: cookie.httpOnly } : {}),
            ...(cookie.secure !== undefined ? { secure: cookie.secure } : {}),
            ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
          })),
        );
      });
    },
    clearCookies(options) {
      rejectUnknownOptions('browser.clearCookies', options, ['name', 'domain', 'path']);
      for (const field of ['name', 'domain', 'path'] as const) {
        const value = options?.[field];
        if (value !== undefined && typeof value !== 'string' && !(value instanceof RegExp)) {
          throw new TestError('INVALID_ARGUMENT', `browser.clearCookies ${field} must be a string or RegExp`);
        }
      }
      return surface.guard(context.operation(), 'clearCookies', () => surface.requireContext().clearCookies(options));
    },
    setViewport: (size) =>
      surface.guard(context.operation(), 'setViewport', async () => {
        await surface.setViewport(size);
        context.attachViewport({ width: size.width, height: size.height, scale: 1 });
      }),
    async emulateMedia(media) {
      if (typeof media !== 'object' || media === null) {
        throw new TestError('INVALID_ARGUMENT', 'browser.emulateMedia takes { colorScheme?, reducedMotion? }');
      }
      rejectUnknownOptions('browser.emulateMedia', media, MEDIA_KEYS);
      for (const key of MEDIA_KEYS) {
        const problem = mediaProblem((name) => `browser.emulateMedia({ ${name} })`, key, media[key]);
        if (problem !== undefined) throw new TestError('INVALID_ARGUMENT', problem);
      }
      // Read once, so a test that changes its object later changes nothing here.
      const requested = obj({ colorScheme: media.colorScheme, reducedMotion: media.reducedMotion });
      await surface.guard(context.operation(), 'emulateMedia', () => surface.emulateMedia(requested));
    },
    async setNetwork(state) {
      if (state !== 'online' && state !== 'offline') {
        throw new TestError('INVALID_ARGUMENT', `browser.setNetwork takes "online" or "offline", got ${JSON.stringify(state)}`);
      }
      await surface.guard(context.operation(), 'setNetwork', () => surface.setOffline(state === 'offline'));
    },
    // Async so the harness records the registration as a `browser.onDialog` step.
    async onDialog(handler: DialogHandler) {
      const unsubscribe = surface.dialogs.add(handler);
      return async () => unsubscribe();
    },
    tabs: () => surface.tabs().map(tabHandle),
    async waitForPopup(trigger, options) {
      rejectUnknownOptions('browser.waitForPopup', options, ['timeout']);
      return tabHandle(await waitForTab(surface, context, trigger, options?.timeout));
    },
    newTab: async () => tabHandle(await surface.newTab(context.operation())),
    async waitForDownload(trigger, options) {
      const [file] = await collectDownloads(surface, context, trigger, 1, options?.timeout, 'browser.waitForDownload');
      return file!;
    },
    async waitForDownloads(trigger, options) {
      rejectUnknownOptions('browser.waitForDownloads', options, ['count', 'timeout']);
      const count = options?.count;
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new TestError('INVALID_ARGUMENT', 'waitForDownloads: count must be a positive safe integer');
      }
      return collectDownloads(surface, context, trigger, count, options.timeout, 'browser.waitForDownloads');
    },
    keyboard: {
      down: (key) =>
        surface.guard(context.operation(), 'keyboard.down', () => surface.requirePage().keyboard.down(key), classifyInputError),
      up: (key) =>
        surface.guard(context.operation(), 'keyboard.up', () => surface.requirePage().keyboard.up(key), classifyInputError),
      press: (key) =>
        surface.guard(context.operation(), 'keyboard.press', () => surface.requirePage().keyboard.press(key), classifyInputError),
      type: (text) =>
        surface.guard(context.operation(), 'keyboard.type', () => surface.requirePage().keyboard.type(text), classifyInputError),
    },
    mouse: {
      move: (x, y) =>
        surface.guard(context.operation(), 'mouse.move', () => surface.requirePage().mouse.move(x, y), classifyInputError),
      wheel: (deltaX, deltaY) =>
        surface.guard(context.operation(), 'mouse.wheel', () => surface.requirePage().mouse.wheel(deltaX, deltaY), classifyInputError),
      down: () => surface.guard(context.operation(), 'mouse.down', () => surface.requirePage().mouse.down(), classifyInputError),
      up: () => surface.guard(context.operation(), 'mouse.up', () => surface.requirePage().mouse.up(), classifyInputError),
    },
    webmcp: createWebMcp(surface, context),
    // Async, so an argument a check refuses rejects like a failed call.
    clock: {
      async install(options) {
        rejectUnknownOptions('browser.clock.install', options, ['time']);
        const time = options?.time;
        await runClock({ method: 'install', ms: time === undefined ? Date.now() : clockTime('browser.clock.install', time) });
      },
      fastForward: async (ticks) => runClock({ method: 'fastForward', ms: clockTicks('browser.clock.fastForward', ticks) }),
      runFor: async (ticks) => runClock({ method: 'runFor', ms: clockTicks('browser.clock.runFor', ticks) }),
      pauseAt: async (time) => runClock({ method: 'pauseAt', ms: clockTime('browser.clock.pauseAt', time) }),
      resume: () => runClock({ method: 'resume' }),
      setFixedTime: async (time) => runClock({ method: 'setFixedTime', ms: clockTime('browser.clock.setFixedTime', time) }),
      setSystemTime: async (time) => runClock({ method: 'setSystemTime', ms: clockTime('browser.clock.setSystemTime', time) }),
    },
  };

  const action: FixtureOperation = { kind: 'resource' };
  const navigationCall = { kind: 'resource', timeout: false } as const;
  const matchers: FixtureOperations<BrowserExpectation> = {
    toHaveURL: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveTitle: { kind: 'assertion', timeout: false, label: (expected) => String(expected) },
    toHaveClass: { kind: 'assertion', timeout: false, label: (_target, expected) => String(expected) },
    get not() { return matchers; },
  };
  return context.fixture('browser', context.expectable(browser, () => context.fixture('expect', expectation, matchers)), {
    goto: { ...navigationCall, label: (url) => url },
    reload: navigationCall,
    back: navigationCall,
    forward: navigationCall,
    url: action,
    title: action,
    waitForURL: { ...navigationCall, verifies: true, label: patternLabel },
    evaluate: action,
    addInitScript: { ...action, label: (script) => initScriptLabel(script) },
    route: { ...action, label: patternLabel },
    unroute: { ...action, label: patternLabel },
    unrouteAll: action,
    waitForResponse: { ...action, timeout: (_pattern, options) => options?.timeout, label: patternLabel },
    waitForRequest: { ...action, timeout: (_pattern, options) => options?.timeout, label: patternLabel },
    cookies: { ...action, label: cookieUrlsLabel },
    setCookies: action,
    clearCookies: action,
    setViewport: action,
    emulateMedia: { ...action, label: (media) => mediaLabel(media) },
    setNetwork: { ...action, label: (state) => String(state) },
    onDialog: action,
    waitForPopup: { ...action, timeout: false },
    newTab: action,
    waitForDownload: { ...action, timeout: false },
    waitForDownloads: { ...action, timeout: false },
    keyboard: { down: { ...action, label: (key) => key }, up: { ...action, label: (key) => key }, press: { ...action, label: (key) => key }, type: { ...action, label: (text) => `${text.length} chars` } },
    mouse: { move: action, wheel: action, down: action, up: action },
    webmcp: { tools: action, callTool: { ...action, label: (name) => String(name) } },
    clock: {
      install: { ...action, label: clockInstallLabel },
      fastForward: { ...action, label: clockTicksLabel },
      runFor: { ...action, label: clockTicksLabel },
      pauseAt: { ...action, label: clockTimeLabel },
      resume: action,
      setFixedTime: { ...action, label: clockTimeLabel },
      setSystemTime: { ...action, label: clockTimeLabel },
    },
  });
}

interface ExpectationDeps {
  currentUrl(deadline: Deadline): Promise<string>;
  currentTitle(deadline: Deadline): Promise<string>;
  baseHref(): string;
  deadlineFor(timeout: number | undefined, api: string): Deadline;
  readonly context: EngineFixtureContext;
}

/** One read of a browser matcher poll: whether the condition holds (undefined: not evaluable yet), and what was seen. */
interface BrowserSample {
  readonly matches: boolean | undefined;
  readonly observed: string;
}

/**
 * Polls one browser condition against the assertion budget and fails with the
 * last read when it times out: the loop behind `expect(browser)` and
 * `browser.waitForURL`. `api` names the call to its timeout, and `name`
 * heads the failure (`expect.not.toHaveURL`, `browser.waitForURL`).
 */
async function pollBrowser(
  deps: ExpectationDeps,
  call: { readonly api: string; readonly name: string; readonly negated: boolean },
  label: string,
  read: (deadline: Deadline) => Promise<BrowserSample>,
  timeout: number | undefined,
): Promise<void> {
  const deadline = deps.deadlineFor(timeout, call.api);
  // pollCondition calls onTimeout only after a read completed, so a sample is always there.
  let last: BrowserSample | undefined;
  await pollCondition({
    deadline,
    signal: deps.context.signal,
    negated: call.negated,
    evaluate: async () => {
      last = await read(deadline);
      return last.matches;
    },
    onTimeout: (cause) =>
      new TestError(
        'ASSERTION_FAILED',
        `${call.name} failed\nexpected: ${call.negated ? 'not ' : ''}${label}\nobserved: ${last?.observed ?? 'nothing'}`,
        cause === undefined ? undefined : { cause },
      ),
  });
}

/**
 * `browser.waitForURL`: the poll `expect(browser).toHaveURL` runs, except
 * that a string is a URL glob (`url-glob.ts`), printed resolved against the
 * base URL when the wait fails. Playwright's `toHaveURL` never reads a glob,
 * so the matcher keeps its exact comparison.
 */
function waitForUrl(deps: ExpectationDeps, expected: string | RegExp, timeout: number | undefined): Promise<void> {
  const { matches, label } = urlPattern(toTextPattern(expected), () => deps.baseHref());
  const call = { api: 'browser.waitForURL', name: 'browser.waitForURL', negated: false };
  return pollBrowser(deps, call, `URL ${label}`, async (deadline) => {
    const url = await deps.currentUrl(deadline);
    return { matches: matches(url), observed: `URL ${url}` };
  }, timeout);
}

/**
 * `expect(browser)` matchers: URL, title, and class polling against the
 * assertion budget. Every read is bounded by the poll's deadline, so a page
 * that stops answering ends the assertion at its own timeout, and the
 * failure reports the last read instead of reading a hung page again.
 */
function createBrowserExpectation(deps: ExpectationDeps, negated = false): BrowserExpectation {
  const poll = (
    api: string,
    label: string,
    read: (deadline: Deadline) => Promise<BrowserSample>,
    timeout: number | undefined,
  ): Promise<void> => pollBrowser(deps, { api, name: `expect.${negated ? 'not.' : ''}${api}`, negated }, label, read, timeout);
  const validate = (api: string, options: object | undefined, keys: readonly string[] = ['timeout']): void =>
    rejectUnknownOptions(`expect.${negated ? 'not.' : ''}${api}`, options, keys);
  return {
    get not() {
      return createBrowserExpectation(deps, !negated);
    },
    toHaveURL(expected, options) {
      validate('toHaveURL', options, ['ignoreCase', 'timeout']);
      const ignoreCase = options?.ignoreCase;
      if (ignoreCase !== undefined && typeof ignoreCase !== 'boolean') {
        throw new TestError('INVALID_ARGUMENT', `expect.${negated ? 'not.' : ''}toHaveURL option ignoreCase must be a boolean`);
      }
      const target = deps.baseHref();
      return poll(
        'toHaveURL',
        `URL ${describeExpectedUrl(expected, target)}${ignoreCase === true ? ' (ignoring case)' : ''}`,
        async (deadline) => {
          const url = await deps.currentUrl(deadline);
          return { matches: urlMatches(url, expected, target, ignoreCase), observed: `URL ${url}` };
        },
        options?.timeout,
      );
    },
    toHaveTitle(expected, options) {
      validate('toHaveTitle', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveTitle',
        `title ${describePattern(pattern)}`,
        async (deadline) => {
          const title = await deps.currentTitle(deadline);
          return { matches: matchesText(title, pattern), observed: `title ${JSON.stringify(title)}` };
        },
        options?.timeout,
      );
    },
    toHaveClass(target, expected, options) {
      validate('toHaveClass', options);
      const pattern = toTextPattern(expected, { exact: true });
      return poll(
        'toHaveClass',
        `class ${describePattern(pattern)}`,
        async (deadline) => {
          let value: string | null | undefined;
          try {
            // A locator read takes the action timeout; the poll's deadline is the tighter bound.
            value = await withTimeout(
              readClass(target),
              deadline.remaining(),
              () => new EngineError('OPERATION_TIMEOUT', 'class read timed out', { retryable: false }),
            );
          } catch (error) {
            if (isTestErrorCode(error, 'LOCATOR_NOT_FOUND')) return { matches: undefined, observed: 'no node' };
            throw error;
          }
          if (value === undefined) return { matches: undefined, observed: 'no node' };
          if (value === null) return { matches: false, observed: 'no class attribute' };
          return {
            matches: matchesText(value.trim().split(/\s+/).join(' '), pattern),
            observed: `class ${JSON.stringify(value)}`,
          };
        },
        options?.timeout,
      );
    },
  };
}

/**
 * The class attribute of one match, `undefined` while nothing matches. A
 * read waits for its match until the action timeout, so the poll samples
 * absence first: a node that never arrives stays an assertion failure.
 */
async function readClass(target: Locator): Promise<string | null | undefined> {
  if ((await target.count()) === 0) return undefined;
  return target.getAttribute('class');
}

function requireSelector(method: string, selector: unknown): string {
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new TestError('INVALID_LOCATOR', `${method}() requires a nonempty selector`);
  }
  return selector;
}

/**
 * The scope for the innermost of `frames` (outermost first). Every query and
 * both escape hatches compile through the same `frame` chain, so a `locator`
 * inside it resolves against the innermost document.
 */
function frameScreen(context: EngineFixtureContext, frames: readonly string[]): FrameScreen {
  const scope = (expression: LocatorExpression): LocatorExpression =>
    frames.reduceRight<LocatorExpression>((source, selector) => ({ kind: 'frame', selector, source }), expression);
  return Object.assign(context.screen(scope), {
    locator: (selector: string) =>
      context.locator(scope({ kind: 'selector', selector: requireSelector('locator', selector) })),
    frameLocator: (selector: string) =>
      frameScreen(context, [...frames, requireSelector('frameLocator', selector)]),
  });
}
