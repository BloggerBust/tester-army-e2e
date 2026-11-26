/** Compile-time assertions for route decisions: the options each one takes, and the ones it refuses at runtime too. */
import type { WebResponse as CoreWebResponse } from '@e2e-dev/core';
import type { Browser, Dialog, PageResponse, RouteContinueOverrides, RouteFulfillResponse, RouteMatcher, WebRequest, WebResponse, WebRoute } from '../../src/index.ts';

({ json: { ok: true }, contentType: 'application/vnd.quote+json' }) satisfies RouteFulfillResponse;
({ path: 'fixtures/quote.json', status: 201 }) satisfies RouteFulfillResponse;
({}) satisfies RouteFulfillResponse;
({ url: '/api/other', method: 'PUT', headers: { 'x-a': 'b' }, postData: '{}' }) satisfies RouteContinueOverrides;
({ headers: { 'x-a': undefined } }) satisfies RouteContinueOverrides;
({ body: new Uint8Array([0, 255]) }) satisfies RouteFulfillResponse;
({ body: Buffer.from('%PDF') }) satisfies RouteFulfillResponse;

// @ts-expect-error a response has one source: `path` and `body` together are not one.
({ path: 'quote.json', body: 'x' }) satisfies RouteFulfillResponse;
// @ts-expect-error a response has one source: `path` and `json` together are not one.
({ path: 'quote.json', json: 1 }) satisfies RouteFulfillResponse;
// @ts-expect-error `fulfill({ response })` from Playwright is not implemented.
({ response: {} }) satisfies RouteFulfillResponse;
// @ts-expect-error header values are strings.
({ headers: { 'x-n': 1 } }) satisfies RouteContinueOverrides;
// @ts-expect-error only a request header can be dropped; a response header is a string.
({ headers: { 'x-a': undefined } }) satisfies RouteFulfillResponse;

({ method: 'POST', url: '**/api/orders' }) satisfies RouteMatcher;
({ method: 'post', url: /\/api\/orders$/ }) satisfies RouteMatcher;
// @ts-expect-error a method-narrowed pattern needs its url
({ method: 'POST' }) satisfies RouteMatcher;
// @ts-expect-error one HTTP method, not a list
({ method: ['GET', 'POST'], url: '**/api/orders' }) satisfies RouteMatcher;
// @ts-expect-error a route pattern takes no extra matchers
({ method: 'POST', url: '**/api/orders', times: 1 }) satisfies RouteMatcher;

declare const browser: Browser;
void (browser.waitForDownload(async () => {}).then(file => file.absolutePath) satisfies Promise<string>);
void (browser.unrouteAll() satisfies Promise<void>);
void (browser.route({ method: 'POST', url: '**/api/orders' }, () => {}) satisfies Promise<void>);
void (browser.unroute({ method: 'POST', url: '**/api/orders' }) satisfies Promise<void>);
void (browser.waitForResponse({ method: 'POST', url: '**/api/orders' }) satisfies Promise<WebResponse>);
// The web engine's response type is core's, the one the request fixture returns.
declare const fromWeb: WebResponse;
declare const fromCore: CoreWebResponse;
void (fromWeb satisfies CoreWebResponse);
void (fromCore satisfies WebResponse);
// A wait takes a predicate over what it returns, sync or async, Playwright's `(response) => boolean | Promise<boolean>`.
void (browser.waitForResponse((response) => response.request.method === 'POST' && response.status === 201) satisfies Promise<PageResponse>);
void (browser.waitForResponse(async (response) => (await response.json<{ ready: boolean }>()).ready, { timeout: 0 }) satisfies Promise<PageResponse>);
void (browser.waitForRequest('**/api/orders') satisfies Promise<WebRequest>);
void (browser.waitForRequest({ method: 'POST', url: '**/api/orders' }) satisfies Promise<WebRequest>);
void (browser.waitForRequest((request) => request.postData?.includes('sku') === true) satisfies Promise<WebRequest>);
// What `waitForResponse` returns is still a `WebResponse`, so `toBeOK` and helpers typed with it take it.
declare const pageResponse: PageResponse;
void (pageResponse satisfies CoreWebResponse);
// A route handler reads the same request type `waitForRequest` returns.
void (({} as WebRoute['request']) satisfies WebRequest);
// @ts-expect-error a predicate returns a boolean, not the response
void browser.waitForResponse((response) => response);
// @ts-expect-error the response's request is a property, not Playwright's `request()`
void browser.waitForResponse((response) => response.request().method() === 'POST');
// @ts-expect-error `route` takes no predicate
void browser.route((url: URL) => url.pathname === '/api', () => {});
// @ts-expect-error a wait takes `timeout` only, not Playwright's `signal`
void browser.waitForRequest('**/api', { signal: AbortSignal.timeout(1) });
// @ts-expect-error a method-narrowed pattern needs its url
void browser.route({ method: 'POST' }, () => {});
// @ts-expect-error clearing routes takes no options
void browser.unrouteAll({ behavior: 'ignoreErrors' });

declare const route: WebRoute;
void (route.fetch().then(response => response.text()) satisfies Promise<string>);
void (route.fetch().then(response => response.body()) satisfies Promise<Buffer>);
// @ts-expect-error upstream fetch currently takes no overrides
void route.fetch({ timeout: 100 });
void route.continue();
void route.fallback();
// @ts-expect-error `abort` takes no Playwright error code.
void route.abort('failed');
// @ts-expect-error `fallback` takes no overrides.
void route.fallback({ url: '/api/other' });

/** Dialog handlers expose only native browser kinds. */
declare const dialog: Dialog;
void (dialog.type satisfies 'alert' | 'confirm' | 'prompt' | 'beforeunload');
// @ts-expect-error the kind is read-only
dialog.type = 'alert';
// @ts-expect-error unsupported native kinds are outside the contract
const futureKind: Dialog['type'] = 'future';
void futureKind;
