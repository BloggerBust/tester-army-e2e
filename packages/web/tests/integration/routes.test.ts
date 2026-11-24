/**
 * Route decisions against a server that counts what reaches it: `continue`
 * goes to the network past every other route and carries the configured
 * headers itself (to the app's origin and the one `credentialOrigins` lists,
 * not another port on the same host), `fallback` hands the request to the
 * route before it, the overrides each decision implements reach the wire,
 * and an option it does not implement fails the next step instead of being
 * dropped. Method-narrowed patterns (`{ method, url }`) match one method and
 * step aside for older routes otherwise, on `route` and `waitForResponse`.
 * Also the one call beside routing that takes a URL the same way: a relative
 * cookie URL.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { Download, Page } from 'playwright-core';
import { TestError, type EngineFixtureContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser, type WebRoute } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

interface Echo {
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Every byte value once, which no text decoding keeps intact. */
const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, index) => index);

/**
 * `/echo` answers with what it received; `/api/*` answers `network:<path>`;
 * `/binary` answers `ALL_BYTES`. Every request is counted by path.
 */
function startCountingServer(hits: Map<string, number>): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://host').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    if (pathname === '/redirect') {
      response.writeHead(302, { location: '/echo' });
      response.end();
      return;
    }
    if (pathname === '/binary') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(ALL_BYTES);
      return;
    }
    if (pathname === '/stream-download') {
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="stream.bin"',
        'content-length': '4096',
      });
      response.write(Buffer.alloc(1024, 'x'));
      return;
    }
    if (pathname === '/echo') {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ path: pathname, method: request.method, headers: request.headers, body }));
      });
      return;
    }
    if (pathname.startsWith('/api/')) {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`network:${pathname}`);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Routes</title><h1>Routes</h1>');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

describe('browser route and waitForResponse decisions', () => {
  let surface: PlaywrightSurface;
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'e2e-routes-'));
  const signal = new AbortController().signal;
  const hits = new Map<string, number>();
  const attached: string[] = [];
  /** The fixture operations the browser was built with, for step-label checks. */
  const operations = new Map<string, unknown>();
  /** The app's server, then the unlisted and listed ports. */
  let server: Server;
  let servers: Server[];
  let origin: string;
  let otherOrigin: string;
  /** Another port on the app's host: the same site, another origin, not listed. */
  let unlistedOrigin: string;
  /** A third port on the app's host, in `credentialOrigins`. */
  let listedOrigin: string;
  let page: Page;
  let browser: Browser;

  /** The harness's navigation rule: relative to the base, only http(s) and the exact `about:blank` admitted. */
  const resolveUrl = (url: string): string => {
    const resolved = new URL(url, `${origin}/`);
    if (!['http:', 'https:'].includes(resolved.protocol) && resolved.href !== 'about:blank') {
      throw new TestError('POLICY_DENIED', `forbidden URL scheme: ${resolved.protocol}`);
    }
    return resolved.href;
  };

  beforeAll(async () => {
    const [started, unlisted, listed] = await Promise.all([startCountingServer(hits), startCountingServer(hits), startCountingServer(hits)]);
    server = started.server;
    servers = [server, unlisted.server, listed.server];
    origin = `http://127.0.0.1:${started.port}`;
    // The same server under another host name: another origin.
    otherOrigin = `http://localhost:${started.port}`;
    unlistedOrigin = `http://127.0.0.1:${unlisted.port}`;
    listedOrigin = `http://127.0.0.1:${listed.port}`;
    surface = new PlaywrightSurface({ headers: { 'X-Gate': 'open-sesame' }, credentialOrigins: [listedOrigin] });
    writeFileSync(path.join(projectRoot, 'quote.json'), '{"cents":4200}\n');
    await surface.init({ runId: 'routes', targetName: 'web', projectRoot, app: { origin, site: '127.0.0.1' },
      env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    hits.clear();
    attached.length = 0;
    operations.clear();
    await surface.startAttempt({ attemptId: 'routes', artifactsDir: projectRoot, signal, resolveSecret: noSecrets, ...ignoreTrace });
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    browser = createBrowserFixture(surface, {
      app: { origin, site: '127.0.0.1', resolveUrl },
      operation: (timeoutMs = 5_000) => ({ signal, timeoutMs, runId: 'routes', attemptId: 'routes', origin: 'test' }),
      timeouts: { test: 5_000, assertion: 5_000 },
      expectable: (target: object) => target,
      fixture: (name: string, target: object, definitions: unknown) => {
        operations.set(name, definitions);
        return target;
      },
      attachArtifact: (_kind: string, relative: string) => attached.push(relative),
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await Promise.all(servers.map((each) => new Promise<void>((resolve) => each.close(() => resolve()))));
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Fetches `url` from the page; a failed fetch reads as `failed`. */
  const fetchText = (url: string): Promise<string> =>
    page.evaluate((target) => fetch(target).then((reply) => reply.text(), () => 'failed'), url);

  /** Fetches `url` from the page and returns its response headers and body. */
  const fetchReply = (url: string): Promise<{ contentType: string | null; body: string }> =>
    page.evaluate(async (target) => {
      const reply = await fetch(target);
      return { contentType: reply.headers.get('content-type'), body: await reply.text() };
    }, url);

  /** Fetches `url` from the page and returns its body bytes. */
  const fetchBytes = async (url: string): Promise<number[]> =>
    page.evaluate((target) => fetch(target).then(async (reply) => [...new Uint8Array(await reply.arrayBuffer())]), url);

  /** Fetches `url` from the page and parses what `/echo` received. */
  const fetchEcho = async (url: string, init?: { method: string; body: string }): Promise<Echo> =>
    JSON.parse(
      await page.evaluate(([target, options]) => fetch(target!, options).then((reply) => reply.text()), [url, init] as const),
    ) as Echo;

  /** Calls a decision the way a JavaScript caller can: any argument, typed or not. */
  const untyped = <T,>(decide: (...args: never[]) => Promise<T>, ...args: unknown[]): Promise<T> =>
    (decide as (...rest: unknown[]) => Promise<T>)(...args);

  /** Waits for the latched route failure the next step reports. */
  const nextStepFailure = (): Promise<unknown> => browser.url().then(() => undefined, (error: unknown) => error);

  it('fetches upstream once, keeps configured headers, then fulfills an amended response', async () => {
    await browser.route('**/echo', async route => {
      const upstream = await route.fetch();
      expect(upstream.status).toBe(200);
      expect(upstream.url).toBe(`${origin}/echo`);
      expect(upstream.headers['content-type']).toContain('application/json');
      const echo = await upstream.json<Echo>();
      expect(echo.headers['x-gate']).toBe('open-sesame');
      expect(JSON.parse(await upstream.text())).toEqual(echo);
      await route.fulfill({ json: { ...echo, amended: true } });
    });
    expect(await page.evaluate(async url => (await fetch(url)).json(), `${origin}/echo`)).toMatchObject({ amended: true });
    expect(hits.get('/echo')).toBe(1);
  });

  it('keeps upstream metadata when the native API response body is unavailable', async () => {
    const context = page.context();
    const register = context.route.bind(context);
    const spy = vi.spyOn(context, 'route').mockImplementation((url, handler, options) => register(url, async (route, request) => {
      const fetch = route.fetch.bind(route);
      route.fetch = async (...args) => {
        const response = await fetch(...args);
        await response.dispose();
        return response;
      };
      await handler(route, request);
    }, options));
    try {
      await browser.route('**/echo', async route => {
        const upstream = await route.fetch();
        expect(upstream.status).toBe(200);
        expect(upstream.url).toBe(`${origin}/echo`);
        expect(upstream.headers['content-type']).toContain('application/json');
        await expect(upstream.text()).rejects.toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('route.fetch') });
        await expect(upstream.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
        await route.fulfill({ body: 'safe fallback' });
      });
      expect(await fetchText(`${origin}/echo`)).toBe('safe fallback');
      expect(hits.get('/echo')).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns an upstream redirect without following it', async () => {
    await browser.route('**/redirect', async route => {
      const upstream = await route.fetch();
      expect(upstream.status).toBe(302);
      expect(upstream.headers['location']).toBe('/echo');
      await route.fulfill({ body: 'inspected redirect' });
    });
    expect(await fetchText(`${origin}/redirect`)).toBe('inspected redirect');
    expect(hits.get('/redirect')).toBe(1);
    expect(hits.get('/echo')).toBeUndefined();
  });

  it('hands timeout 0 to the operation as a budget only the test deadline caps, and refuses a negative one', async () => {
    const asked: (number | undefined)[] = [];
    const recording = createBrowserFixture(surface, {
      app: { site: '127.0.0.1', resolveUrl },
      operation: (timeoutMs?: number) => {
        asked.push(timeoutMs);
        return { signal, timeoutMs: Math.min(timeoutMs ?? 5_000, 5_000), runId: 'routes', attemptId: 'routes', origin: 'test' };
      },
      timeouts: { test: 5_000, action: 5_000, assertion: 5_000 },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext);
    await recording.goto(`${origin}/`, { timeout: 0 });
    await recording.waitForURL(`${origin}/`, { timeout: 0 });
    expect(asked.slice(0, 2)).toEqual([Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    for (const call of [
      async () => recording.goto(`${origin}/`, { timeout: -1 }),
      async () => recording.waitForURL(`${origin}/`, { timeout: Number.NaN }),
      async () => recording.waitForDownload(async () => undefined, { timeout: Number.POSITIVE_INFINITY }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
  });

  it('rejects an invalid download count before running the trigger', async () => {
    let calls = 0;
    await expect(browser.waitForDownloads(async () => { calls += 1; }, { count: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(calls).toBe(0);
  });

  it('removes a multi-download listener after an incomplete trigger times out', async () => {
    const listeners = (page as unknown as EventEmitter).listenerCount('download');
    await expect(browser.waitForDownloads(async () => undefined, { count: 2, timeout: 30 })).rejects.toMatchObject({
      code: 'ACTION_FAILED', message: expect.stringContaining('0 of 2 downloads'),
    });
    expect((page as unknown as EventEmitter).listenerCount('download')).toBe(listeners);
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s bounds saving a download whose HTTP body never finishes', async (method) => {
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/stream-download';
      link.textContent = 'Stream';
      document.body.append(link);
    });
    const baseline = (page as unknown as EventEmitter).listenerCount('download');
    let download: Download | undefined;
    page.once('download', (value) => { download = value; });
    const trigger = () => page.evaluate(() => document.querySelector<HTMLAnchorElement>('a')!.click());
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => 'completed', (cause: unknown) => cause),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still pending'), 1500); }),
      ]);
      expect(download).toBeDefined();
      expect(result).toMatchObject({ code: 'ACTION_FAILED', message: expect.stringContaining('did not finish') });
      expect((page as unknown as EventEmitter).listenerCount('download')).toBe(baseline);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await download?.cancel();
      await work.catch(() => undefined);
    }
  });

  it.each(['waitForDownload', 'waitForDownloads'] as const)('%s closes started downloads while its trigger is still pending', async (method) => {
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/stream-download';
      link.textContent = 'Pending';
      document.body.append(link);
    });
    const listeners = (page as unknown as EventEmitter).listenerCount('download');
    let download: Download | undefined;
    page.once('download', (value) => { download = value; });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const trigger = async (): Promise<void> => {
      await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a')!.click());
      await pending;
    };
    const work = method === 'waitForDownload'
      ? browser.waitForDownload(trigger, { timeout: 500 })
      : browser.waitForDownloads(trigger, { count: 1, timeout: 500 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work.then(() => 'completed', (cause: unknown) => cause),
        new Promise((resolve) => { timer = setTimeout(() => resolve('still pending'), 1500); }),
      ]);
      expect(result).toMatchObject({ code: 'ACTION_FAILED' });
      expect(download).toBeDefined();
      expect((page as unknown as EventEmitter).listenerCount('download')).toBe(listeners);
      expect(await download!.failure()).toMatch(/cancel/);
      release();
      await work.catch(() => undefined);
      expect(attached).toEqual([]);
    } finally {
      clearTimeout(timer);
      release();
      server.closeAllConnections();
      await download?.cancel();
      await work.catch(() => undefined);
    }
  });

  it('keeps a trigger error and removes the multi-download listener immediately', async () => {
    const listeners = (page as unknown as EventEmitter).listenerCount('download');
    const failure = new TestError('ASSERTION_FAILED', 'trigger assertion');
    await expect(browser.waitForDownloads(async () => { throw failure; }, { count: 2, timeout: 30 })).rejects.toBe(failure);
    expect((page as unknown as EventEmitter).listenerCount('download')).toBe(listeners);
  });

  it('clears every test route, keeps configured headers, and can register again', async () => {
    await browser.route('**/api/**', route => route.fulfill({ body: 'mock-api' }));
    await browser.route(/\/echo$/, route => route.fulfill({ json: { intercepted: true } }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('mock-api');
    await browser.unrouteAll();
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
    expect((await fetchEcho(`${origin}/echo`)).headers['x-gate']).toBe('open-sesame');
    await browser.unrouteAll();
    await browser.route('**/api/quote', route => route.fulfill({ body: 'new-mock' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('new-mock');
    await browser.unroute('**/api/quote');
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
  });

  it('routes real native dialogs by kind even when their messages are identical', async () => {
    const kinds: string[] = [];
    const off = await browser.onDialog(async dialog => {
      kinds.push(dialog.type);
      if (dialog.type === 'prompt') await dialog.accept('typed answer');
      else if (dialog.type === 'confirm') await dialog.dismiss();
      else await dialog.accept();
    });
    const answers = await browser.evaluate(() => {
      window.alert('same message');
      return { confirmed: window.confirm('same message'), prompt: window.prompt('same message') };
    });
    expect(kinds).toEqual(['alert', 'confirm', 'prompt']);
    expect(answers).toEqual({ confirmed: false, prompt: 'typed answer' });
    await off();
  });

  it('answers with the route registered last when two fulfill', async () => {
    await browser.route('**/api/**', (route) => route.fulfill({ body: 'earlier' }));
    await browser.route('**/api/quote', (route) => route.fulfill({ body: 'later' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('later');
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  /**
   * One grammar: each row answers the same through `route` (a fetch from the
   * page reaches the handler) and `waitForURL` (the page at that URL
   * satisfies the wait), relative patterns resolved against the app's URL.
   */
  const SHARED_PATTERNS: readonly (readonly [pattern: string, pathname: string, matches: boolean])[] = [
    ['**/api/quote', '/api/quote', true],
    ['/api/quote', '/api/quote', true],
    ['/api/*', '/api/quote', true],
    ['/api/*', '/api/a/b', false],
    ['/api/**', '/api/a/b', true],
    ['**/api/{quote,flags}', '/api/flags', true],
    ['**/api/{quote,flags}', '/api/other', false],
    ['**/api/quote?id=*', '/api/quote?id=7', true],
    ['**/api/quote?id=?', '/api/quote?id=7', false],
    ['**/api/q?ote', '/api/quote', false],
    ['**/api/my file*', '/api/my%20file.txt', true],
    ['/api/quote#a*/../flags', '/api/flags', false],
  ];

  /** A miss is that call's timeout; any other rejection fails the row instead of reading as `false`. */
  const missed = (timeoutCode: string) => (error: { readonly code?: string }): false => {
    if (error.code !== timeoutCode) throw error;
    return false;
  };

  it.each(SHARED_PATTERNS)('reads %s against %s the same through route, waitForURL, and waitForResponse', async (pattern, pathname, expected) => {
    await browser.route(pattern, (route) => route.fulfill({ body: 'routed' }));
    expect((await fetchText(`${origin}${pathname}`)) === 'routed', 'route').toBe(expected);
    await browser.unrouteAll();
    await page.goto(`${origin}${pathname}`);
    const waited = await browser.waitForURL(pattern, { timeout: 200 }).then(() => true, missed('ASSERTION_FAILED'));
    expect(waited, 'waitForURL').toBe(expected);
    const [responded] = await Promise.all([
      browser.waitForResponse(pattern, { timeout: 300 }).then(() => true, missed('OPERATION_TIMEOUT')),
      page.evaluate((url) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); }, `${origin}${pathname}`),
    ]);
    expect(responded, 'waitForResponse').toBe(expected);
  });

  /** The `browser` fixture on a target with no `app.url`, whose base URL throws as the harness's does. */
  const noAppUrlBrowser = () => createBrowserFixture(surface, {
    app: { site: '127.0.0.1', resolveUrl: () => { throw new TestError('APP_URL_REQUIRED', 'this target has no app.url'); } },
    operation: (timeoutMs?: number) => ({ signal, timeoutMs: Math.min(timeoutMs ?? 5_000, 5_000), runId: 'routes', attemptId: 'routes-no-app' }),
    timeouts: { test: 5_000, action: 5_000, assertion: 5_000 },
    expectable: (target: object) => target,
    fixture: (_fixture: string, target: object) => target,
    attachArtifact: () => undefined,
  } as unknown as EngineFixtureContext);

  it.each([
    ['an absolute URL', (): string | RegExp => `${origin}/api/quote`],
    ['a ** glob', (): string | RegExp => '**/api/quote'],
    ['a RegExp', (): string | RegExp => /\/api\/quote$/],
  ])('routes and waits on %s on a target with no app URL', async (_name, patternFor) => {
    const noAppUrl = noAppUrlBrowser();
    const pattern = patternFor();
    await noAppUrl.route(pattern, (route) => route.fulfill({ body: 'routed' }));
    const [response, body] = await Promise.all([noAppUrl.waitForResponse(pattern), fetchText(`${origin}/api/quote`)]);
    expect(body).toBe('routed');
    expect(response.url).toBe(`${origin}/api/quote`);
    await noAppUrl.unrouteAll();
    await page.goto(`${origin}/api/quote`);
    await noAppUrl.waitForURL(pattern, { timeout: 1_000 });
  });

  it('refuses a bad { that resolving would drop, and registers no route', async () => {
    expect(() => browser.route('/{bad/../api/quote', (route) => route.fulfill({ body: 'routed' }))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
  });

  it('refuses a relative pattern on a target with no app URL', async () => {
    const noAppUrl = noAppUrlBrowser();
    expect(() => noAppUrl.route('/api/quote', (route) => route.continue())).toThrow(expect.objectContaining({ code: 'APP_URL_REQUIRED' }));
    await expect((async () => noAppUrl.waitForURL('/api/quote', { timeout: 200 }))()).rejects.toMatchObject({ code: 'APP_URL_REQUIRED' });
  });

  it('matches one method and lets another reach the network', async () => {
    await browser.route({ method: 'post', url: '**/api/orders' }, (route) => route.fulfill({ status: 201, json: { ok: true } }));
    const posted = await page.evaluate(async (url) => {
      const reply = await fetch(url, { method: 'POST', body: 'payload' });
      return { status: reply.status, body: await reply.text() };
    }, `${origin}/api/orders`);
    expect(posted).toEqual({ status: 201, body: '{"ok":true}' });
    expect(await fetchText(`${origin}/api/orders`)).toBe('network:/api/orders');
    expect(hits.get('/api/orders')).toBe(1);
  });

  it('matches a method-narrowed RegExp url', async () => {
    await browser.route({ method: 'POST', url: /\/api\/orders$/ }, (route) => route.fulfill({ body: 'post' }));
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('post');
    expect(await fetchText(`${origin}/api/orders`)).toBe('network:/api/orders');
  });

  it('matches a lowercase custom method', async () => {
    await browser.route({ method: 'PATCH', url: '**/api/orders' }, (route) => route.fulfill({ body: 'patched' }));
    const patched = await page.evaluate(async (url) => (await fetch(url, { method: 'patch' })).text(), `${origin}/api/orders`);
    expect(patched).toBe('patched');
  });

  it('a method-narrowed route steps aside for an older route', async () => {
    await browser.route('**/api/orders', (route) => route.fulfill({ body: 'any method' }));
    await browser.route({ method: 'POST', url: '**/api/orders' }, (route) => route.fulfill({ body: 'post' }));
    expect(await fetchText(`${origin}/api/orders`)).toBe('any method');
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('post');
  });

  it('a method-narrowed route steps aside for an older method-narrowed route', async () => {
    await browser.route({ method: 'GET', url: '**/api/orders' }, (route) => route.fulfill({ body: 'get' }));
    await browser.route({ method: 'POST', url: '**/api/orders' }, (route) => route.fulfill({ body: 'post' }));
    expect(await fetchText(`${origin}/api/orders`)).toBe('get');
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('post');
    const deleted = await page.evaluate(async (url) => (await fetch(url, { method: 'DELETE' })).text(), `${origin}/api/orders`);
    expect(deleted).toBe('network:/api/orders');
  });

  it('a method fallback reaches an older route that continues', async () => {
    await browser.route('**/echo', (route) => route.continue());
    await browser.route({ method: 'POST', url: '**/echo' }, (route) => route.fulfill({ body: 'post' }));
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.method).toBe('GET');
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('a method fallback reaches an older route that aborts', async () => {
    await browser.route('**/api/quote', (route) => route.abort());
    await browser.route({ method: 'POST', url: '**/api/quote' }, (route) => route.fulfill({ body: 'post' }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it('a method mismatch lets the configured headers reach the network', async () => {
    await browser.route({ method: 'POST', url: '**/echo' }, (route) => route.fulfill({ body: 'post' }));
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.method).toBe('GET');
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('keeps a method-narrowed route across a restart', async () => {
    await browser.route({ method: 'POST', url: '**/api/orders' }, (route) => route.fulfill({ body: 'post' }));
    await surface.restart({ signal, timeoutMs: 5_000, runId: 'routes', attemptId: 'routes', origin: 'test' });
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('post');
  });

  it('unroutes a method-narrowed route without touching a URL-only one', async () => {
    await browser.route('**/api/orders', (route) => route.fulfill({ body: 'any method' }));
    await browser.route({ method: 'POST', url: '**/api/orders' }, (route) => route.fulfill({ body: 'post' }));
    await browser.unroute({ method: 'post', url: '**/api/orders' });
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('any method');
  });

  it('unrouting a URL only leaves a method-narrowed route', async () => {
    await browser.route({ method: 'POST', url: '**/api/orders' }, (route) => route.fulfill({ body: 'post' }));
    await browser.unroute('**/api/orders');
    const posted = await page.evaluate(async (url) => (await fetch(url, { method: 'POST' })).text(), `${origin}/api/orders`);
    expect(posted).toBe('post');
  });

  it('waits for a response of one method, ignoring another', async () => {
    const pending = browser.waitForResponse({ method: 'POST', url: '**/echo' });
    await fetchText(`${origin}/echo`);
    await page.evaluate(async (url) => {
      await fetch(url, { method: 'POST', body: 'other' });
    }, `${origin}/api/other`);
    const posted = page.evaluate(async (url) => {
      await fetch(url, { method: 'POST', body: 'payload' });
    }, `${origin}/echo`);
    const response = await pending;
    expect(response.url).toBe(`${origin}/echo`);
    expect(await response.json()).toMatchObject({ path: '/echo', method: 'POST', body: 'payload' });
    await posted;
  });

  it('labels a method-narrowed pattern with its method and URL', () => {
    const definitions = operations.get('browser') as
      | Record<string, { label?: (...args: unknown[]) => string }>
      | undefined;
    const label = definitions?.['route']?.label;
    expect(label).toBeTypeOf('function');
    expect(label?.({ method: 'post', url: '**/api/orders' })).toBe('POST "**/api/orders"');
    expect(label?.({ method: 'POST', url: /orders$/ })).toBe('POST /orders$/');
    expect(label?.({ method: 'POST', url: Object.create(null) })).toBe('POST an object');
    const cyclic: { method: string; url?: unknown } = { method: 'POST' };
    cyclic.url = cyclic;
    expect(label?.(cyclic)).toBe('POST an object');
  });

  const members = [
    ['browser.route', (pattern: unknown) => untyped(browser.route, pattern, () => undefined)],
    ['browser.unroute', (pattern: unknown) => untyped(browser.unroute, pattern)],
    ['browser.waitForResponse', (pattern: unknown) => untyped(browser.waitForResponse, pattern)],
  ] as const;

  it.each(members)('%s rejects invalid method-narrowed patterns', (api, call) => {
    const cases = [
      [{}, 'must be a string, RegExp, or { method, url }; got an object'],
      [{ method: 'POST' }, 'requires url'],
      [{ url: '**/api/orders' }, 'requires method'],
      [{ method: '', url: '**/api/orders' }, 'got ""'],
      [{ method: 'PO ST', url: '**/api/orders' }, 'got "PO ST"'],
      [{ method: 'POST', url: '**/api/orders', times: 1 }, 'has unknown key "times"'],
      [{ method: 'POST', url: 42 }, 'url must be a string or RegExp, got 42'],
    ] as const;
    for (const [pattern, message] of cases) {
      let caught: unknown;
      try {
        call(pattern);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect((caught as Error).message).toContain(`${api} pattern`);
      expect((caught as Error).message).toContain(message);
    }
  });

  it('continue goes to the network past an earlier route', async () => {
    let earlier = 0;
    await browser.route('**/api/**', (route) => {
      earlier += 1;
      return route.fulfill({ body: 'earlier' });
    });
    await browser.route('**/api/quote', (route) => route.continue());
    expect(await fetchText(`${origin}/api/quote`)).toBe('network:/api/quote');
    expect(earlier).toBe(0);
    expect(hits.get('/api/quote')).toBe(1);
  });

  it('fallback hands the request to the route before it', async () => {
    await browser.route('**/api/**', (route) => route.fulfill({ body: 'earlier' }));
    await browser.route('**/api/quote', (route) => route.fallback());
    expect(await fetchText(`${origin}/api/quote`)).toBe('earlier');
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['continue', (route: WebRoute) => route.continue()],
    ['fallback', (route: WebRoute) => route.fallback()],
  ])('keeps the configured header through %s', async (_name, decide) => {
    await browser.route('**/echo', decide);
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('continue replaces the request headers and adds the configured header on top', async () => {
    await browser.route('**/echo', (route) =>
      route.continue({ headers: { ...route.request.headers, 'X-Added': 'yes', 'X-GATE': 'forged' } }));
    const echo = await fetchEcho(`${origin}/echo`);
    expect(echo.headers['x-added']).toBe('yes');
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it.each([
    ['the request', '/echo'],
    ['a redirect', '/redirect'],
  ])('continue drops a header set to undefined on %s', async (_name, target) => {
    await browser.route(`**${target}`, (route) =>
      route.continue({ headers: { ...route.request.headers, 'x-drop': undefined, 'x-keep': 'yes' } }));
    const echo = JSON.parse(await page.evaluate(
      (url) => fetch(url, { headers: { 'x-drop': 'a' } }).then((reply) => reply.text()),
      `${origin}${target}`,
    )) as Echo;
    expect(echo.path).toBe('/echo');
    expect(echo.headers['x-drop']).toBeUndefined();
    expect(echo.headers['x-keep']).toBe('yes');
    expect(echo.headers['x-gate']).toBe('open-sesame');
  });

  it('continue sends a rewritten url, method, and body without touching the original', async () => {
    await browser.route('**/api/quote', (route) =>
      route.continue({ url: '/echo', method: 'PUT', postData: 'payload' }));
    const echo = await fetchEcho(`${origin}/api/quote`, { method: 'POST', body: 'original' });
    expect([echo.path, echo.method, echo.body]).toEqual(['/echo', 'PUT', 'payload']);
    expect(echo.headers['x-gate']).toBe('open-sesame');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(hits.get('/echo')).toBe(1);
  });

  it('continue to another port on the same host leaves the configured header behind, and to a listed origin keeps it', async () => {
    await browser.route('**/api/unlisted', (route) => route.continue({ url: `${unlistedOrigin}/echo` }));
    await browser.route('**/api/listed', (route) => route.continue({ url: `${listedOrigin}/echo` }));
    expect((await fetchEcho(`${origin}/api/unlisted`)).headers['x-gate']).toBeUndefined();
    expect((await fetchEcho(`${origin}/api/listed`)).headers['x-gate']).toBe('open-sesame');
  });

  it('fetch sends the configured header to a listed origin, not another port on the same host', async () => {
    const sent = new Map<string, string | undefined>();
    await browser.route('**/echo', async (route) => {
      const echo = await (await route.fetch()).json<Echo>();
      sent.set(new URL(route.request.url).origin, echo.headers['x-gate']);
      await route.fulfill({ body: '' });
    });
    // Cross-origin from the page, so the fulfilled reply fails CORS; the route has already read the echo.
    for (const target of [unlistedOrigin, listedOrigin]) {
      await page.evaluate((url) => fetch(url).then(() => undefined, () => undefined), `${target}/echo`);
    }
    expect(Object.fromEntries(sent)).toEqual({ [unlistedOrigin]: undefined, [listedOrigin]: 'open-sesame' });
  });

  it('continue to another origin leaves the configured header behind', async () => {
    await browser.route('**/api/quote', (route) => route.continue({ url: `${otherOrigin}/echo` }));
    const echo = await fetchEcho(`${origin}/api/quote`);
    expect(echo.headers.host).toBe(`localhost:${new URL(origin).port}`);
    expect(echo.headers['x-gate']).toBeUndefined();
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['a forbidden scheme', 'file:///etc/hosts', 'POLICY_DENIED', 'forbidden URL scheme: file:'],
    ['a wrapped scheme', 'view-source:file:///etc/hosts', 'POLICY_DENIED', 'forbidden URL scheme: view-source:'],
    ['about:blank', 'about:blank', 'INVALID_ARGUMENT', "route.continue url must keep the request's http: scheme; got about:"],
    ['another scheme', 'https://127.0.0.1/echo', 'INVALID_ARGUMENT', "route.continue url must keep the request's http: scheme; got https:"],
  ])('continue to %s aborts the request and fails the next step', async (_name, url, code, message) => {
    await browser.route('**/api/quote', (route) => route.continue({ url }));
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({ code, message });
  });

  it('fulfills a project file with its bytes and a type from its extension', async () => {
    await browser.route('**/api/quote', (route) => route.fulfill({ path: 'quote.json' }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'application/json', body: '{"cents":4200}\n' });
    expect(hits.get('/api/quote')).toBeUndefined();
  });

  it.each([
    ['a Buffer', Buffer.from(ALL_BYTES)],
    ['a Uint8Array view', new Uint8Array([0xff, ...ALL_BYTES, 0xff]).subarray(1, 257)],
  ])('fulfills %s body byte for byte', async (_name, body) => {
    await browser.route('**/api/quote', (route) => route.fulfill({ body }));
    expect(await fetchBytes(`${origin}/api/quote`)).toEqual([...ALL_BYTES]);
  });

  it('fetches upstream bytes and fulfills them unchanged', async () => {
    await browser.route('**/binary', async (route) => {
      const upstream = await route.fetch();
      await route.fulfill({ headers: upstream.headers, body: await upstream.body() });
    });
    expect(await fetchBytes(`${origin}/binary`)).toEqual([...ALL_BYTES]);
  });

  it('fulfills a newline-joined set-cookie as one cookie per line', async () => {
    await browser.route('**/api/quote', (route) =>
      route.fulfill({ headers: { 'Set-Cookie': 'a=b\nc=d; Path=/' }, body: '' }));
    await fetchText(`${origin}/api/quote`);
    expect((await browser.cookies()).map(({ name, value }) => `${name}=${value}`).toSorted()).toEqual(['a=b', 'c=d']);
  });

  it('fulfills under the given contentType or a content-type header', async () => {
    await browser.route('**/api/quote', (route) => route.fulfill({ json: { cents: 1 }, contentType: 'application/vnd.quote+json' }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'application/vnd.quote+json', body: '{"cents":1}' });
    await browser.route('**/api/quote', (route) => route.fulfill({ path: 'quote.json', headers: { 'Content-Type': 'text/plain' } }));
    expect(await fetchReply(`${origin}/api/quote`)).toEqual({ contentType: 'text/plain', body: '{"cents":4200}\n' });
  });

  it.each([
    ['an unknown fulfill key', (route: WebRoute) => untyped(route.fulfill, { bodyy: 'typo' }),
      'route.fulfill options has no key "bodyy"; it takes status, headers, contentType, json, body, path'],
    ['two fulfill sources', (route: WebRoute) => untyped(route.fulfill, { body: 'a', json: { b: 1 } }),
      'route.fulfill takes one of json, body, or path; got json and body'],
    ['a missing fulfill file', (route: WebRoute) => route.fulfill({ path: 'missing.json' }),
      `route.fulfill path is not a readable file: ${path.join(projectRoot, 'missing.json')}`],
    ['a fulfill status out of range', (route: WebRoute) => route.fulfill({ status: 42 }),
      'route.fulfill status must be an integer from 100 to 599'],
    ['an unknown continue key', (route: WebRoute) => untyped(route.continue, { urll: '/echo' }),
      'route.continue options has no key "urll"; it takes url, method, headers, postData'],
    ['non-string continue headers', (route: WebRoute) => untyped(route.continue, { headers: { 'x-n': 1 } }),
      'route.continue header "x-n" must be a string, got number'],
    ['a continue header name outside the token grammar', (route: WebRoute) => route.continue({ headers: { 'x a': 'b' } }),
      'route.continue has an invalid header name: "x a"'],
    ['a line break in a fulfill header value', (route: WebRoute) => route.fulfill({ headers: { 'x-a': 'b\r\nset-cookie: c=d' } }),
      'route.fulfill header "x-a" must not contain a control character'],
    ['a carriage return in a set-cookie line', (route: WebRoute) => route.fulfill({ headers: { 'set-cookie': 'a=b\r\nx-a: c' } }),
      'route.fulfill header "set-cookie" must not contain a control character'],
    ['an undefined fulfill header', (route: WebRoute) => untyped(route.fulfill, { headers: { 'x-a': undefined } }),
      'route.fulfill header "x-a" must be a string, got undefined'],
    ['a line break in a continue header value', (route: WebRoute) => route.continue({ headers: { 'set-cookie': 'a=b\nc=d' } }),
      'route.continue header "set-cookie" must not contain a control character'],
    ['a fulfill body that is neither text nor bytes', (route: WebRoute) => untyped(route.fulfill, { body: 42 }),
      'route.fulfill body must be a string, Buffer, or Uint8Array'],
    ['an abort error code', (route: WebRoute) => untyped(route.abort, 'failed'),
      'route.abort() takes no arguments'],
  ])('rejects %s before deciding, and aborts the request', async (_name, decide, message) => {
    await browser.route('**/api/quote', decide);
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({ code: 'INVALID_ARGUMENT', message });
  });

  it('aborts the request when the handler returns without deciding, and fails the next step', async () => {
    await browser.route('**/api/quote', () => undefined);
    expect(await fetchText(`${origin}/api/quote`)).toBe('failed');
    expect(hits.get('/api/quote')).toBeUndefined();
    expect(await nextStepFailure()).toMatchObject({
      code: 'ACTION_FAILED',
      message: 'route handler returned without calling fulfill, continue, fallback, or abort',
    });
  });

  it('keeps the first decision when the handler decides twice, and fails the next step', async () => {
    await browser.route('**/api/quote', (route) => {
      void route.fulfill({ body: 'first' });
      return route.fulfill({ body: 'second' });
    });
    expect(await fetchText(`${origin}/api/quote`)).toBe('first');
    expect(await nextStepFailure()).toMatchObject({
      code: 'ACTION_FAILED',
      message: 'route handler already decided; fulfill called twice',
    });
  });

  it('fails a navigation its route aborted as an action failure, not an engine fault', async () => {
    await browser.route('**/aborted', (route) => route.abort());
    await expect(browser.goto(`${origin}/aborted`)).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining(`navigation failed: a route aborted the request for ${origin}/aborted`),
    });
  });

  it('fails a navigation with the route error that aborted it', async () => {
    await browser.route('**/refused', (route) => route.fulfill({ headers: { 'bad name': 'x' } }));
    await expect(browser.goto(`${origin}/refused`)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('invalid header name: "bad name"'),
    });
    await expect(browser.url()).resolves.toBe(`${origin}/`);
  });

  it('takes the decision the moment fulfill is called, awaited or not', async () => {
    await browser.route('**/api/quote', (route) => { void route.fulfill({ path: 'quote.json' }); });
    expect(await fetchText(`${origin}/api/quote`)).toBe('{"cents":4200}\n');
    await expect(browser.url()).resolves.toBe(`${origin}/`);
  });

  it('sets a cookie with a relative url on the base URL', async () => {
    await browser.setCookies([{ name: 'flavor', value: 'oatmeal', url: '/' }]);
    const cookies = await browser.cookies();
    expect(cookies.map(({ name, value, domain, path: cookiePath }) => ({ name, value, domain, path: cookiePath })))
      .toEqual([{ name: 'flavor', value: 'oatmeal', domain: '127.0.0.1', path: '/' }]);
  });
});
