/** The `request` fixture: HTTP calls from a test, each one a step bounded by the test's budget. */

import { validateHeaderName, validateHeaderValue } from 'node:http';
import { ConfigurationError, errorMessage, messageWithCauses, TestError } from '../internal/errors.ts';
import { validateJsonValue } from '../internal/json-value.ts';
import { isPlainObject, rejectUnknownOptions } from '../internal/options.ts';
import { MAX_TIMER_MS, stepTimeout, withAbort, withScopedBudget } from '../internal/time.ts';
import type { NormalizedBaseUrl } from '../internal/urls.ts';
import type { APIRequest, APIRequestFetchOptions, APIRequestOptions, WebResponse } from '../types.ts';
import type { AttemptEnvironment } from './fixtures.ts';

/** What one call runs under, read when the call starts. */
export interface RequestWiring {
  readonly environment: AttemptEnvironment;
  /** The action timeout in milliseconds, read when each call starts. */
  readonly actionTimeout: () => number;
}

/** Builds the `request` fixture over one attempt. */
export function createRequest(wiring: RequestWiring): APIRequest {
  const call = (method: string) => (url: string, options?: APIRequestOptions) =>
    send(wiring, `request.${method.toLowerCase()}`, () => method, url, options);
  return {
    fetch: (url, options) => send(wiring, 'request.fetch', () => methodOf(options), url, options),
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    patch: call('PATCH'),
    delete: call('DELETE'),
    head: call('HEAD'),
  };
}

/** One call, checked before it is sent: its step label, and what goes out or why it cannot. */
type Prepared = { readonly label: string } & (
  | { readonly url: URL; readonly init: RequestInit; readonly timeoutMs: number | undefined }
  | { readonly refused: unknown }
);

/**
 * Sends one request inside a `resource` step and returns its buffered
 * response. A refused call still opens the step and rejects inside it; its
 * label is `METHOD /path` once the method and URL passed, else empty, so
 * nothing a refused URL holds is shown.
 */
function send(
  wiring: RequestWiring,
  api: string,
  readMethod: () => string,
  input: unknown,
  options: APIRequestOptions | undefined,
): Promise<WebResponse> {
  const { environment } = wiring;
  const prepared = prepare(api, readMethod, input, options, environment.target.app.base);
  return environment.steps.run('resource', api, prepared.label, () => {
    if ('refused' in prepared) return Promise.reject(prepared.refused);
    const { url, init, label } = prepared;
    const timeoutMs = prepared.timeoutMs ?? wiring.actionTimeout();
    const { signal } = environment.budget;
    return withAbort(
      () => withScopedBudget(
        timeoutMs,
        signal,
        () => new TestError('ACTION_FAILED', `${label} exceeded its timeout of ${timeoutMs}ms`),
        (scoped) => exchange(url, init, label, scoped),
      ),
      signal,
      () => new TestError('CANCELLED', `${label} cancelled`),
    );
  });
}

/** Checks the method and URL of one call, then its options. */
function prepare(
  api: string,
  readMethod: () => string,
  input: unknown,
  options: APIRequestOptions | undefined,
  base: NormalizedBaseUrl | undefined,
): Prepared {
  let method: string;
  let url: URL;
  try {
    method = readMethod();
    url = requestUrl(input, base);
  } catch (refused) {
    return { label: '', refused };
  }
  const label = `${method} ${shownUrl(url, base)}`;
  try {
    const init = requestInit(api, method, options);
    return { label, url, init, timeoutMs: requestTimeout(options?.timeout, api) };
  } catch (refused) {
    return { label, refused };
  }
}

/** A call's own `timeout`: `stepTimeout`'s rules, at most what a timer can hold. */
function requestTimeout(timeout: unknown, api: string): number | undefined {
  const own = stepTimeout(timeout, api);
  if (own !== undefined && own !== Number.POSITIVE_INFINITY && own > MAX_TIMER_MS) {
    throw new TestError('INVALID_ARGUMENT', `${api} timeout must be at most ${MAX_TIMER_MS} milliseconds, got ${own}`);
  }
  return own;
}

/** The fetch and the body read, both under `signal`; a network failure is `ACTION_FAILED` naming the call. */
async function exchange(url: URL, init: RequestInit, label: string, signal: AbortSignal): Promise<WebResponse> {
  try {
    const response = await fetch(url, { ...init, signal });
    const body = new Uint8Array(await response.arrayBuffer());
    return webResponse(response, body, label);
  } catch (cause) {
    // An abort is the budget's or the timeout's: the wrappers above report it.
    if (signal.aborted) throw cause;
    throw new TestError('ACTION_FAILED', `${label} failed: ${networkReason(cause)}`, { cause });
  }
}

/** Why fetch failed: undici's `fetch failed` and its causes, an `AggregateError`'s per-address failures included. */
function networkReason(cause: unknown): string {
  return cause instanceof Error ? messageWithCauses(cause) : errorMessage(cause);
}

/** The method `request.fetch` sends: `options.method` upper-cased, GET when absent. */
function methodOf(options: APIRequestFetchOptions | undefined): string {
  const method = options?.method;
  if (method === undefined) return 'GET';
  if (typeof method !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) {
    throw new TestError('INVALID_ARGUMENT', 'request.fetch: method must be an HTTP method name, such as "GET"');
  }
  const upper = method.toUpperCase();
  if (UNSENDABLE_METHODS.has(upper)) {
    throw new TestError('INVALID_ARGUMENT', `request.fetch: ${upper} is not supported; CONNECT, TRACE, and TRACK cannot be sent`);
  }
  return upper;
}

/** The methods Node's fetch refuses to send. */
const UNSENDABLE_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

/** The headers Node's fetch sets, overwrites, or drops, so the test would not send what it names. */
const OVERWRITTEN_HEADERS = new Set(['content-length', 'host', 'sec-fetch-mode']);

/**
 * The headers Node's fetch refuses to send. They are refused here by name, so
 * a runtime whose fetch would send them (Bun) refuses them the same way.
 */
const UNSENDABLE_HEADERS = new Set(['expect', 'keep-alive', 'transfer-encoding', 'upgrade']);

/** The `connection` values sent as written: Node's fetch sends `close` for any value listing it, else `keep-alive`. */
const CONNECTION_VALUES = new Set(['close', 'keep-alive']);

/** Valid `redirect` modes for `fetch`. */
const REDIRECT_MODES = new Set<RequestRedirect>(['follow', 'manual', 'error']);

/**
 * The URL a call goes to: a path resolved against the app URL as `app.open`
 * resolves one, or an absolute one. Only http(s) passes, so unlike a
 * navigation, `about:blank` is refused too. No refusal quotes the input.
 */
function requestUrl(input: unknown, base: NormalizedBaseUrl | undefined): URL {
  if (typeof input !== 'string' || input === '') {
    throw new TestError('INVALID_ARGUMENT', 'request: url must be a non-empty string, a path or an absolute http(s) URL');
  }
  // Only an input with no scheme is a path; `http://[bad` stays malformed.
  if (base === undefined && !/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new ConfigurationError(
      'APP_URL_REQUIRED',
      'request: a path needs an app URL to resolve against; the target declares no app.url, so pass an absolute URL',
    );
  }
  let url: URL;
  try {
    url = new URL(input, base?.href);
  } catch {
    throw new ConfigurationError('POLICY_DENIED', 'request: malformed URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TestError('INVALID_ARGUMENT', 'request: a URL must not contain credentials; send them in headers');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigurationError('POLICY_DENIED', 'request: a URL must be a path or an absolute http(s) URL');
  }
  return url;
}

/** The URL as a step label shows it: the path on the app's origin, the origin too elsewhere; never the query. */
function shownUrl(url: URL, base: NormalizedBaseUrl | undefined): string {
  return url.origin === base?.origin ? url.pathname : `${url.origin}${url.pathname}`;
}

/** The options every method takes; `request.fetch` takes `method` too. */
const OPTION_KEYS = ['headers', 'json', 'body', 'timeout', 'redirect'] as const;

/** The fetch init for one call: its method, headers, body, and redirect mode. An option it does not know is refused, never dropped. */
function requestInit(api: string, method: string, options: APIRequestOptions | undefined): RequestInit {
  rejectUnknownOptions(api, options, api === 'request.fetch' ? [...OPTION_KEYS, 'method'] : OPTION_KEYS);
  const given: unknown = options?.headers;
  if (given !== undefined && !isPlainObject(given)) {
    throw new TestError('INVALID_ARGUMENT', 'request: headers must be an object of header names to string values');
  }
  const headers = new Headers();
  let acceptEncodingName: string | undefined;
  for (const [name, value] of Object.entries(given ?? {})) {
    if (typeof value !== 'string') throw new TestError('INVALID_ARGUMENT', `request: header "${name}" must be a string`);
    const lower = name.toLowerCase();
    if (OVERWRITTEN_HEADERS.has(lower)) {
      throw new TestError('INVALID_ARGUMENT', `request: header "${name}" is set by fetch itself; leave it out`);
    }
    if (UNSENDABLE_HEADERS.has(lower)) {
      throw new TestError('INVALID_ARGUMENT', `request: header "${name}" cannot be sent with fetch; leave it out`);
    }
    if (lower === 'connection' && !CONNECTION_VALUES.has(value.trim().toLowerCase())) {
      throw new TestError('INVALID_ARGUMENT', `request: header "${name}" must be close or keep-alive; fetch manages the connection`);
    }
    if (lower === 'accept-encoding') acceptEncodingName = name;
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
      headers.set(name, value);
    } catch {
      // The value is not quoted: it may be a credential.
      throw new TestError('INVALID_ARGUMENT', `request: header "${name}" has an invalid name or value`);
    }
  }
  if (acceptEncodingName !== undefined && headers.has('range')) {
    throw new TestError(
      'INVALID_ARGUMENT',
      `request: header "${acceptEncodingName}" cannot be combined with "range"; fetch appends identity to accept-encoding on range requests`,
    );
  }
  const body = requestBody(options, headers);
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TestError('INVALID_ARGUMENT', `request: a ${method} request takes no body`);
  }
  const redirect = requestRedirect(options?.redirect);
  return {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(redirect === undefined ? {} : { redirect }),
  };
}

/** How redirects are handled: `'follow'` by default, or `'manual'` / `'error'`. */
function requestRedirect(redirect: unknown): RequestRedirect | undefined {
  if (redirect === undefined) return undefined;
  if (typeof redirect !== 'string' || !REDIRECT_MODES.has(redirect as RequestRedirect)) {
    throw new TestError('INVALID_ARGUMENT', 'request: redirect must be "follow", "manual", or "error"');
  }
  return redirect as RequestRedirect;
}

/** The body of one call: `json` serialized, else `body` as given; content-type defaults to JSON for `json`. */
function requestBody(options: APIRequestOptions | undefined, headers: Headers): string | undefined {
  const json: unknown = options?.json;
  const raw = options?.body;
  if (json !== undefined && raw !== undefined) throw new TestError('INVALID_ARGUMENT', 'request: pass json or body, not both');
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new TestError('INVALID_ARGUMENT', 'request: body must be a string');
    return raw;
  }
  if (json === undefined) return undefined;
  validateJsonValue(json, 'request: json');
  const text = JSON.stringify(json);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return text;
}

/**
 * The body parsed as JSON. V8's own error quotes the start of the text, which
 * can be part of a secret the ledger only redacts whole, so the error names
 * the call and quotes nothing.
 */
function parseBody<T>(text: string, label: string): T {
  try {
    // oxlint-disable-next-line e2e/no-unchecked-json -- public API: the caller names T, unknown by default
    return JSON.parse(text) as T;
  } catch {
    throw new SyntaxError(`the response body of ${label} is not valid JSON`);
  }
}

/** A `WebResponse` whose body was read inside the call's step. */
function webResponse(response: Response, body: Uint8Array, label: string): WebResponse {
  // fromEntries defines each name as its own property, `__proto__` included.
  const headers: Record<string, string> = Object.fromEntries([...response.headers].filter(([name]) => name !== 'set-cookie'));
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies.join('\n');
  const text = (): string => new TextDecoder().decode(body);
  return {
    url: response.url,
    status: response.status,
    headers,
    body: async () => Buffer.from(body),
    text: async () => text(),
    json: async <T = unknown>() => parseBody<T>(text(), label),
  };
}
