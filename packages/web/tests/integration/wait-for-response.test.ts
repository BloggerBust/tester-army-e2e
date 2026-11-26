import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { withTimeout, type EngineFixtureContext } from '@e2e-dev/core/engine';
import { PlaywrightSurface } from '../../src/surface.ts';
import { createBrowserFixture, type Browser, type PageResponse, type WebRequest } from '../../src/browser.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/**
 * One origin with a body for every outcome `waitForResponse` reports: a full
 * JSON body, a genuinely empty body under 200 and 204, a redirect whose body
 * the browser drops, and a body cut short by a connection reset before the
 * declared `Content-Length` was sent, one whose body follows its headers
 * 800ms later, and one that never finishes. The fragment is flushed before the
 * reset so the browser has seen the headers and reports the response rather
 * than an empty reply.
 */
function startBodyServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    switch (request.url) {
      case '/api/held':
        // No headers until the test calls `releaseHeld`.
        held.push(response);
        return;
      case '/':
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>Bodies</title><h1>Bodies</h1>');
        return;
      case '/api/full':
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      case '/api/orders':
        response.writeHead(request.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ method: request.method }));
        return;
      case '/api/empty':
        response.writeHead(200, { 'content-type': 'text/plain', 'content-length': '0' });
        response.end();
        return;
      case '/api/no-content':
        response.writeHead(204);
        response.end();
        return;
      case '/api/redirect':
        response.writeHead(302, { location: '/api/full', 'content-type': 'text/plain' });
        response.end('moved');
        return;
      case '/api/slow':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.flushHeaders();
        setTimeout(() => response.end('slow-body'), 800);
        return;
      case '/api/endless':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.write('a first chunk and never the rest');
        return;
      case '/api/cut':
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
        response.write('{"partial":', () => {
          setTimeout(() => response.socket?.destroy(), 50);
        });
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Requests to `/api/held`, whose response has not started. */
const held: ServerResponse[] = [];

/** Answers every held request. */
function releaseHeld(): void {
  for (const response of held.splice(0)) response.end('released');
}

describe('browser.waitForResponse and waitForRequest', () => {
  const surface = new PlaywrightSurface({});
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-wait-for-response-'));
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  let page: Page;
  let browser: Browser;
  let operationBudgetMs: number;
  /** The signal each `browser` call's operation carries: the step's, which a test can abort. */
  let stepSignal: AbortSignal;

  beforeAll(async () => {
    ({ server, url: origin } = await startBodyServer());
    await surface.init({ runId: 'responses', targetName: 'web', projectRoot: process.cwd(),
      app: {}, env: {}, headed: false, workerSlot: 0, signal, log: () => undefined });
  });

  beforeEach(async () => {
    await surface.startAttempt({ attemptId: 'responses', artifactsDir, signal, resolveSecret: noSecrets, ...ignoreTrace });
    operationBudgetMs = 2_000;
    stepSignal = signal;
    browser = createBrowserFixture(surface, {
      app: { resolveUrl: (url: string) => new URL(url, `${origin}/`).href },
      timeouts: { test: 5_000 },
      operation: (timeoutMs = operationBudgetMs) => ({ signal: stepSignal, timeoutMs, runId: 'responses', attemptId: 'responses', origin: 'test' }),
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
    } as unknown as EngineFixtureContext);
  });

  afterEach(async () => {
    releaseHeld();
    await surface.endAttempt({ signal, timeoutMs: 5_000 });
  });

  afterAll(async () => {
    await surface.dispose({ signal, timeoutMs: 5_000 });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /**
   * Fires one page-side fetch that reads its body the way an app does and
   * returns the response `waitForResponse` observed for it.
   */
  async function observe(pathname: string, options?: { timeout: number }) {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    // The harness's step bound, as the fixture recorder applies it to every `browser` call.
    const bound = options?.timeout ?? 2_000;
    const [response] = await Promise.all([
      withTimeout(browser.waitForResponse(`**${pathname}`, options), bound, () => new Error(`step exceeded ${bound}ms`)),
      page.evaluate(
        (url) => { void fetch(url).then((reply) => reply.text()).catch(() => undefined); },
        `${origin}${pathname}`,
      ),
    ]);
    return response;
  }

  it('observes the first navigation before any page is open', async () => {
    const [response] = await Promise.all([
      browser.waitForResponse(`${origin}/`),
      browser.goto('/'),
    ]);
    expect(response.url).toBe(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html');
    await expect(response.text()).resolves.toContain('<h1>Bodies</h1>');
    expect(surface.requireContext().pages()).toEqual([surface.requirePage()]);
  });

  it('reads a full body as text and JSON', async () => {
    const response = await observe('/api/full');
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('{"ok":true}');
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it.each([
    ['/api/empty', 200],
    ['/api/no-content', 204],
  ])('resolves a genuinely empty body at %s to an empty string', async (pathname, status) => {
    const response = await observe(pathname);
    expect(response.status).toBe(status);
    await expect(response.text()).resolves.toBe('');
  });

  it('keeps the status of a body the connection cut short and rejects reading it', async () => {
    const response = await observe('/api/cut');
    expect(response.status).toBe(200);
    expect(response.url).toBe(`${origin}/api/cut`);
    expect(response.headers['content-length']).toBe('1000');
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'waitForResponse: response body could not be read: net::ERR_CONTENT_LENGTH_MISMATCH',
    });
    await expect(response.json()).rejects.toMatchObject({ code: 'ACTION_FAILED' });
  });

  it('matches on headers inside its timeout and lets text() wait for a slower body', async () => {
    const response = await observe('/api/slow', { timeout: 500 });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('slow-body');
  });

  it('rejects reading a body that never finishes once the action budget runs out', async () => {
    const response = await observe('/api/endless', { timeout: 500 });
    expect(response.status).toBe(200);
    operationBudgetMs = 300;
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: 'waitForResponse: response body did not finish within 300ms',
    });
  });

  /** Opens the page, then runs `requests` in it without waiting on them, as an app's own fetches. */
  async function fire(requests: string): Promise<void> {
    await page.evaluate(`void (async () => { ${requests} })().catch(() => undefined)`);
  }

  it('returns the response a predicate accepts, the same object it saw, with its request', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    let seen: PageResponse | undefined;
    const [response] = await Promise.all([
      browser.waitForResponse((candidate) => {
        if (candidate.request.method !== 'POST') return false;
        seen = candidate;
        return true;
      }),
      fire(`await fetch('/api/orders'); await fetch('/api/orders', { method: 'POST', body: '{"sku":1}' });`),
    ]);
    expect(response).toBe(seen);
    expect(response.status).toBe(201);
    expect(response.request).toMatchObject({ url: `${origin}/api/orders`, method: 'POST', postData: '{"sku":1}' });
    await expect(response.json()).resolves.toEqual({ method: 'POST' });
  });

  it('takes an async predicate that reads bodies, bounded by the wait and not the action budget', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    operationBudgetMs = 300;
    const [response] = await Promise.all([
      browser.waitForResponse(async (candidate) => (await candidate.text()) === 'slow-body', { timeout: 2_000 }),
      fire(`await fetch('/api/full').then((r) => r.text()); await fetch('/api/slow').then((r) => r.text());`),
    ]);
    expect(response.url).toBe(`${origin}/api/slow`);
    await expect(response.text()).resolves.toBe('slow-body');
  });

  it('fails the wait with what a predicate throws, untouched', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const thrown = new Error('not this one');
    const [failure] = await Promise.all([
      browser.waitForResponse(() => { throw thrown; }).catch((caught: unknown) => caught),
      fire(`await fetch('/api/full');`),
    ]);
    expect(failure).toBe(thrown);
    expect(thrown.message).toBe('not this one');
    const [value] = await Promise.all([
      // oxlint-disable-next-line no-throw-literal -- a thrown non-Error is what the test checks
      browser.waitForRequest(async () => { throw 'a string'; }).catch((caught: unknown) => caught),
      fire(`await fetch('/api/full');`),
    ]);
    expect(value).toBe('a string');
  });

  it('cancels the body read of a response the wait passed over once it settles', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    let passedOver: unknown;
    const [response] = await Promise.all([
      browser.waitForResponse(async (candidate) => {
        if (candidate.url.endsWith('/api/endless')) {
          try {
            await candidate.text();
          } catch (cause) {
            passedOver = cause;
          }
          return false;
        }
        return candidate.url.endsWith('/api/full');
      }),
      fire(`void fetch('/api/endless').then((r) => r.text()); await new Promise((r) => setTimeout(r, 100)); await fetch('/api/full');`),
    ]);
    expect(response.url).toBe(`${origin}/api/full`);
    await vi.waitFor(() => expect(passedOver).toMatchObject({ code: 'CANCELLED' }));
  });

  it('reads the body of a response the wait passed over after it settles', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const seen: PageResponse[] = [];
    await Promise.all([
      browser.waitForResponse(async (candidate) => {
        seen.push(candidate);
        return candidate.url.includes('/api/') && (await candidate.json<{ method?: string }>()).method === 'POST';
      }),
      fire(`await fetch('/api/full').then((r) => r.text()); await fetch('/api/orders', { method: 'POST' }).then((r) => r.text());`),
    ]);
    const passedOver = seen.find((candidate) => candidate.url.endsWith('/api/full'));
    await expect(passedOver?.json()).resolves.toEqual({ ok: true });
  });

  it('keeps a read the predicate left pending on the response it returns', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    let pending: Promise<string> | undefined;
    const [response] = await Promise.all([
      browser.waitForResponse((candidate) => {
        if (!candidate.url.endsWith('/api/slow')) return false;
        pending = candidate.text();
        return true;
      }),
      fire(`await fetch('/api/slow').then((r) => r.text());`),
    ]);
    await expect(pending).resolves.toBe('slow-body');
    await expect(response.text()).resolves.toBe('slow-body');
  });

  it('keeps the timeout when a predicate throws after it', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const [failure] = await Promise.all([
      browser.waitForResponse(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        throw new Error('too late');
      }, { timeout: 200 }).catch((caught: unknown) => caught),
      fire(`await fetch('/api/full');`),
    ]);
    expect(failure).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    // The late throw lands after the wait settled and must not surface anywhere.
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it('stops listening once the step is aborted', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    // Playwright's client `Page` is an event emitter at runtime; its types leave `listenerCount` out.
    const emitter = page as unknown as { listenerCount(event: string): number };
    const listening = () => emitter.listenerCount('response') + emitter.listenerCount('request');
    const before = listening();
    const step = new AbortController();
    stepSignal = step.signal;
    let calls = 0;
    const waits = [
      browser.waitForResponse(() => ++calls < 0).catch((caught: unknown) => caught),
      browser.waitForRequest(() => ++calls < 0).catch((caught: unknown) => caught),
    ];
    await vi.waitFor(() => expect(listening()).toBe(before + 2));
    step.abort();
    for (const failure of await Promise.all(waits)) expect(failure).toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(listening()).toBe(before));
    await page.evaluate(() => fetch('/api/full').then((reply) => reply.text()));
    expect(calls).toBe(0);
  });

  it('waits for a request before any page is open and returns the object its predicate saw', async () => {
    let seen: WebRequest | undefined;
    const [request] = await Promise.all([
      browser.waitForRequest((candidate) => {
        seen = candidate;
        // Truthy is enough, as in Playwright.
        return candidate.url as unknown as boolean;
      }),
      browser.goto('/'),
    ]);
    expect(request).toBe(seen);
    expect(request).toMatchObject({ url: `${origin}/`, method: 'GET' });
  });

  it('refuses an option it does not take', async () => {
    const options = { signal: new AbortController().signal } as unknown as { timeout: number };
    expect(() => browser.waitForResponse('**/api/full', options)).toThrow('browser.waitForResponse options has no key "signal"');
    expect(() => browser.waitForRequest('**/api/full', options)).toThrow('browser.waitForRequest options has no key "signal"');
  });

  it('resolves a request wait before the response starts', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const [request] = await Promise.all([
      browser.waitForRequest('**/api/held', { timeout: 2_000 }),
      fire(`void fetch('/api/held');`),
    ]);
    expect(request.url).toBe(`${origin}/api/held`);
    // The server still holds the response: a wait that needed it could only have timed out.
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(held[0]?.headersSent).toBe(false);
  });

  it('waits for a request by glob, method, and predicate', async () => {
    page = await surface.ensurePage();
    await page.goto(`${origin}/`);
    const [byGlob, byMethod, byPredicate] = await Promise.all([
      browser.waitForRequest('**/api/endless'),
      browser.waitForRequest({ method: 'post', url: '**/api/orders' }),
      browser.waitForRequest((request) => request.postData === '{"sku":2}'),
      fire(`void fetch('/api/endless'); await fetch('/api/orders'); await fetch('/api/orders', { method: 'POST', body: '{"sku":2}' });`),
    ]);
    expect(byGlob).toMatchObject({ url: `${origin}/api/endless`, method: 'GET' });
    expect(byGlob.postData).toBeUndefined();
    expect(byMethod).toMatchObject({ method: 'POST', postData: '{"sku":2}' });
    expect(byPredicate).toMatchObject({ url: `${origin}/api/orders`, method: 'POST' });
    expect(byPredicate.headers['content-type']).toBe('text/plain;charset=UTF-8');
  });

  it('keeps the status of a redirect and rejects reading its body', async () => {
    const response = await observe('/api/redirect');
    expect(response.status).toBe(302);
    await expect(response.text()).rejects.toMatchObject({
      code: 'ACTION_FAILED',
      message: expect.stringContaining('Response body is unavailable for redirect responses'),
    });
  });
});
