import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { type ChildProcess, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { EnvCredentialStore, FileCredentialStore } from '../../../src/oauth/store.ts';
import { OAuthError } from '../../../src/oauth/errors.ts';
import { createOAuthFetch } from '../../../src/oauth/fetch.ts';
import { type OAuthCredentials, type OAuthProvider } from '../../../src/oauth/types.ts';
import { MemoryCredentialStore } from './helpers/store.ts';
import { json, useServers } from '../../helpers/recording-server.ts';
import { onFakeTimeouts } from './helpers/time.ts';

const serve = useServers(afterEach);
const execFileAsync = promisify(execFile);

type CountingProvider = OAuthProvider<OAuthCredentials, never> & { refreshes: string[] };

/** Refreshes rotate the refresh token and reject a token that was already rotated, like SpaceXSI and ChatGPT do. */
function provider(overrides: Partial<OAuthProvider<OAuthCredentials, never>> = {}): CountingProvider {
  const self: CountingProvider = {
    id: 'test',
    name: 'Test',
    refreshes: [],
    async login() {
      return { access: 'x', refresh: 'y', expires: 0 };
    },
    async refresh(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      if (self.refreshes.includes(credentials.refresh)) throw new OAuthError('LOGIN_REQUIRED', `refresh token ${credentials.refresh} was already used`);
      self.refreshes.push(credentials.refresh);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const n = self.refreshes.length;
      return { access: `fresh-${n}`, refresh: `rt-${n}`, expires: Date.now() + 3_600_000 };
    },
    ...overrides,
  };
  return self;
}

describe('createOAuthFetch', () => {
  it('does not refresh or send a request whose signal was already aborted', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    const testProvider = provider();
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    const controller = new AbortController();
    controller.abort();
    await expect(fetch(api.url, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(testProvider.refreshes).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it('cancels one refresh waiter without cancelling the shared refresh another request needs', async () => {
    const api = await serve((_request, response) => json(response, 200, { ok: true }));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    let refreshCount = 0;
    let release!: (credentials: OAuthCredentials) => void;
    let started!: () => void;
    const refreshStarted = new Promise<void>(resolve => { started = resolve; });
    const testProvider = provider({ refresh: () => {
      refreshCount += 1;
      started();
      return new Promise<OAuthCredentials>(resolve => { release = resolve; });
    } });
    const first = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    const second = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    const controller = new AbortController();
    let cancelled: unknown;
    const abandoned = first(api.url, { signal: controller.signal }).catch(error => { cancelled = error; });
    await refreshStarted;
    const active = second(api.url);
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    try {
      expect(cancelled).toBe(controller.signal.reason);
      expect(api.requests).toEqual([]);
    } finally {
      release({ access: 'fresh', refresh: 'rotated', expires: Date.now() + 3_600_000 });
      await abandoned;
    }
    expect(await (await active).json()).toEqual({ ok: true });
    expect(refreshCount).toBe(1);
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.headers.authorization).toBe('Bearer fresh');
    expect(await store.get('test')).toMatchObject({ access: 'fresh', refresh: 'rotated' });
  });

  it('swaps the SDK key header for the bearer token and names the product', async () => {
    const api = await serve((_request, response) => json(response, 200, { ok: true }));
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: 'r', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'my-product/1.0' });
    const response = await fetch(`${api.url}/v1/thing`, { method: 'POST', headers: { 'x-api-key': 'oauth', authorization: 'Bearer oauth' }, body: '{}' });
    expect(await response.json()).toEqual({ ok: true });
    const [request] = api.requests;
    expect(request?.headers['authorization']).toBe('Bearer tok');
    expect(request?.headers['x-api-key']).toBeUndefined();
    expect(request?.headers['user-agent']).toBe('my-product/1.0');
    expect(request?.body).toBe('{}');
  });

  it('fails with NOT_LOGGED_IN and the hint when nothing is stored', async () => {
    const fetch = createOAuthFetch(provider(), { store: new MemoryCredentialStore(), userAgent: 'p', loginHint: 'run e2e login test' });
    await expect(fetch('http://127.0.0.1:1/')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN', message: expect.stringContaining('run e2e login test') });
  });

  it('refreshes an expiring token once across model instances that share a store', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    const first = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    const second = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await Promise.all([first(api.url), second(api.url), first(api.url)]);
    expect(testProvider.refreshes).toEqual(['rt-0']);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1', 'Bearer fresh-1']);
    expect(await store.get('test')).toMatchObject({ access: 'fresh-1', refresh: 'rt-1' });
  });

  it('uses the token another process stored while this one waited for the lock, sending no refresh', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    // Another process refreshed and wrote a fresh token while this one waited for the lock.
    store.exclusive = async (providerId, refresh) => {
      await store.set(providerId, { access: 'theirs', refresh: 'rt-1', expires: Date.now() + 3_600_000 });
      return refresh();
    };
    const testProvider = provider();
    await createOAuthFetch(testProvider, { store, userAgent: 'p' })(api.url);
    expect(testProvider.refreshes).toEqual([]);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer theirs']);
  });

  it('refreshes a token another process stored when that token is expiring too', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    // Another process wrote a different token while this one waited for the lock, and that token lapses too.
    store.exclusive = async (providerId, refresh) => {
      await store.set(providerId, { access: 'other', refresh: 'rt-1', expires: Date.now() + 1_000 });
      return refresh();
    };
    const testProvider = provider();
    await createOAuthFetch(testProvider, { store, userAgent: 'p' })(api.url);
    expect(testProvider.refreshes).toEqual(['rt-1']);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1']);
  });

  it('shares one refresh between separate file stores over the same file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-fetch-'));
    try {
      const file = path.join(dir, 'oauth.json');
      await new FileCredentialStore(file).set('test', { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 });
      const api = await serve((_request, response) => json(response, 200, {}));
      const testProvider = provider();
      const first = createOAuthFetch(testProvider, { store: new FileCredentialStore(file), userAgent: 'p' });
      const second = createOAuthFetch(testProvider, { store: new FileCredentialStore(file), userAgent: 'p' });
      await Promise.all([first(api.url), second(api.url)]);
      expect(testProvider.refreshes).toEqual(['rt-0']);
      expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refreshes an expired login once for workers in separate processes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-fetch-'));
    try {
      const file = path.join(dir, 'oauth.json');
      await new FileCredentialStore(file).set('test', { access: 'at-0', refresh: 'rt-0', expires: 1 });
      let live = { access: 'at-0', refresh: 'rt-0' };
      let issued = 0;
      const vendor = await serve(async (request, response) => {
        if (request.url !== '/token') {
          json(response, request.headers['authorization'] === `Bearer ${live.access}` ? 200 : 401, {});
          return;
        }
        const presented = new URLSearchParams(request.body).get('refresh_token');
        if (presented !== live.refresh) {
          json(response, 400, { error: 'invalid_grant', error_description: 'refresh_token_reused' });
          return;
        }
        issued += 1;
        live = { access: `at-${issued}`, refresh: `rt-${issued}` };
        // Long enough for every worker to reach the token endpoint while the first refresh is still out.
        await new Promise((resolve) => setTimeout(resolve, 500));
        json(response, 200, { access_token: live.access, refresh_token: live.refresh, expires_in: 3600 });
      });
      const worker = [
        '--import',
        new URL('../../../src/config/register.ts', import.meta.url).href,
        fileURLToPath(new URL('./helpers/refresh-worker.ts', import.meta.url)),
      ];
      const args = [...worker, file, `${vendor.url}/token`, `${vendor.url}/api`];
      // Killed when the test ends, even on a timeout, so a worker that hangs is not left running.
      const children: ChildProcess[] = [];
      onTestFinished(() => {
        for (const child of children) child.kill('SIGKILL');
      });
      const run = async () => {
        const pending = execFileAsync(process.execPath, args);
        children.push(pending.child);
        return (await pending).stdout;
      };
      const statuses = await Promise.all(Array.from({ length: 4 }, run));
      expect(statuses).toEqual(['200', '200', '200', '200']);
      expect(vendor.requests.filter((request) => request.url === '/token')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps credentials it renewed for a source that cannot store them', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new EnvCredentialStore(JSON.stringify({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } }));
    const testProvider = provider();
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await fetch(api.url);
    await fetch(api.url);
    expect(testProvider.refreshes).toEqual(['rt-0']);
    expect(api.requests.map((request) => request.headers['authorization'])).toEqual(['Bearer fresh-1', 'Bearer fresh-1']);
  });

  it('fails with LOGIN_REQUIRED and the hint when the refresh token is rejected for good', async () => {
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    testProvider.refreshes.push('rt-0');
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p', loginHint: 'run `npx e2e login test`' });
    await expect(onFakeTimeouts(() => fetch('http://127.0.0.1:1/'))).rejects.toMatchObject({
      code: 'LOGIN_REQUIRED',
      message: 'refresh token rt-0 was already used; run `npx e2e login test`',
    });
  });

  it('uses the credentials another process stored when its own refresh token was already rotated', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: Date.now() + 1_000 } });
    const testProvider = provider();
    testProvider.refreshes.push('rt-0');
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    // The other process rotated the token and stores it a moment after this one was rejected.
    await onFakeTimeouts(async () => {
      setTimeout(() => void store.set('test', { access: 'theirs', refresh: 'rt-1', expires: Date.now() + 3_600_000 }), 300);
      await fetch(api.url);
    });
    expect(api.requests[0]?.headers['authorization']).toBe('Bearer theirs');
  });

  it('waits for another process to store a rotated token only after releasing the refresh lock', async () => {
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    let held = false;
    let readsWhileHeld = 0;
    store.exclusive = async (_providerId, refresh) => {
      held = true;
      try {
        return await refresh();
      } finally {
        held = false;
      }
    };
    const get = store.get.bind(store);
    store.get = async (providerId) => {
      if (held) readsWhileHeld += 1;
      return get(providerId);
    };
    const testProvider = provider();
    testProvider.refreshes.push('rt-0');
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await expect(onFakeTimeouts(() => fetch('http://127.0.0.1:1/'))).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    // The re-read alone; the 2 s poll runs after release, so waiters on a revoked login do not wait it out in turn.
    expect(readsWhileHeld).toBe(1);
  });

  it('fails with LOGIN_REQUIRED when the token another process stored is rejected too', async () => {
    const api = await serve((_request, response) => json(response, 200, {}));
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    store.exclusive = async (providerId, refresh) => {
      await store.set(providerId, { access: 'other', refresh: 'rt-1', expires: Date.now() + 1_000 });
      return refresh();
    };
    const testProvider = provider({
      async refresh(credentials) {
        testProvider.refreshes.push(credentials.refresh);
        throw new OAuthError('LOGIN_REQUIRED', `refresh token ${credentials.refresh} was revoked`);
      },
    });
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p' });
    await expect(onFakeTimeouts(() => fetch(api.url))).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    // The poll waits for a token other than the one this refresh sent, not the one it read before the lock.
    expect(testProvider.refreshes).toEqual(['rt-1']);
    expect(api.requests).toEqual([]);
  });

  it('passes on any other refresh failure as it is, without waiting for another process', async () => {
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 1 } });
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (providerId) => {
      reads += 1;
      return get(providerId);
    };
    const testProvider = provider({
      async refresh() {
        throw new OAuthError('FLOW_FAILED', 'the token response is missing refresh_token');
      },
    });
    const fetch = createOAuthFetch(testProvider, { store, userAgent: 'p', loginHint: 'run `npx e2e login test`' });
    await expect(onFakeTimeouts(() => fetch('http://127.0.0.1:1/'))).rejects.toMatchObject({
      code: 'FLOW_FAILED',
      message: 'the token response is missing refresh_token',
    });
    // The read before the refresh and the re-read inside the lock; no poll for a rotated token.
    expect(reads).toBe(2);
  });

  it('retries once with a refreshed token after a 401, also for a Request input', async () => {
    const api = await serve((request, response) => {
      if (request.headers['authorization'] === 'Bearer stale') json(response, 401, { error: 'expired' });
      else json(response, 200, { echo: request.body });
    });
    const store = new MemoryCredentialStore({ test: { access: 'stale', refresh: 'rt-0', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    const response = await fetch(new Request(api.url, { method: 'POST', body: 'payload' }));
    expect(await response.json()).toEqual({ echo: 'payload' });
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.body).toBe('payload');
  });

  it('fails with LOGIN_REQUIRED and the hint on a 401 for a token that cannot be refreshed, without a retry', async () => {
    const api = await serve((_request, response) => json(response, 401, { message: 'Bad credentials' }));
    const store = new MemoryCredentialStore({ test: { access: 'gh', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p', loginHint: 'run `npx e2e login test`' });
    await expect(fetch(api.url)).rejects.toMatchObject({
      code: 'LOGIN_REQUIRED',
      message: 'Test rejected the stored token (401: Bad credentials); run `npx e2e login test`',
    });
    expect(api.requests).toHaveLength(1);
  });

  it('lets the provider send the request its own way', async () => {
    const api = await serve((request, response) => json(response, 200, { path: request.url, marker: request.headers['x-marker'] }));
    const store = new MemoryCredentialStore({ test: { access: 'tok', refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(
      provider({
        async send(request, credentials, upstream) {
          const headers = new Headers(request.headers);
          headers.set('x-marker', credentials.access);
          const response = await upstream(new Request(new URL('/rewritten', request.url), { headers }));
          return new Response(JSON.stringify({ wrapped: await response.json() }), { status: response.status });
        },
      }),
      { store, userAgent: 'p' },
    );
    expect(await (await fetch(`${api.url}/original`)).json()).toEqual({ wrapped: { path: '/rewritten', marker: 'tok' } });
  });

  it('has the run redact the access and refresh tokens before it sends one, so an answer that quotes it back is redacted', async () => {
    const access = 'oauth-access-token-91be07c4a2d653f8';
    const refresh = 'oauth-refresh-token-3d8e61f0b7a942c5';
    const seen: string[] = [];
    const api = await serve((request, response) => {
      // What the run would make of the token, at the moment the vendor receives it.
      seen.push(processSecrets.redact(request.headers['authorization'] ?? ''));
      json(response, 401, { error: { message: `invalid token ${access}` } });
    });
    expect(processSecrets.redact(`${access} ${refresh}`)).toBe(`${access} ${refresh}`);
    const store = new MemoryCredentialStore({ test: { access, refresh: '', expires: 0 } });
    const fetch = createOAuthFetch(provider(), { store, userAgent: 'p' });
    const error = await fetch(api.url).then(() => undefined, (rejection: unknown) => rejection);
    expect(seen).toEqual(['Bearer <secret:test.access-token>']);
    expect(error).toMatchObject({ code: 'LOGIN_REQUIRED' });
    expect(processSecrets.redact((error as Error).message)).toContain('invalid token <secret:test.access-token>');
    const rotating = new MemoryCredentialStore({ test: { access, refresh, expires: 0 } });
    await createOAuthFetch(provider(), { store: rotating, userAgent: 'p' })(api.url).catch(() => undefined);
    expect(processSecrets.redact(refresh)).toBe('<secret:test.refresh-token>');
  });

  it('has the run redact an expired login before it is sent to be renewed, and the renewed one before it is sent on', async () => {
    const stale = { access: 'oauth-stale-access-6e0c2a8f4b1d7935', refresh: 'oauth-stale-refresh-9a4d1f7c3e0b5826', expires: 1 };
    const renewed = { access: 'oauth-renewed-access-2f8b5d1a7c3e9046', refresh: 'oauth-renewed-refresh-5c1e9a3f7b0d2468', expires: Date.now() + 3_600_000 };
    const atRefresh: string[] = [];
    const atRequest: string[] = [];
    const api = await serve((request, response) => {
      atRequest.push(processSecrets.redact(request.headers['authorization'] ?? ''));
      json(response, 200, { ok: true });
    });
    const store = new MemoryCredentialStore({ test: stale });
    const fetch = createOAuthFetch(
      provider({
        async refresh(credentials) {
          // What the run would make of an answer from the token endpoint that quotes the grant back.
          atRefresh.push(processSecrets.redact(`${credentials.access} ${credentials.refresh}`));
          return renewed;
        },
      }),
      { store, userAgent: 'p' },
    );
    expect(processSecrets.redact(stale.refresh)).toBe(stale.refresh);
    await fetch(api.url);
    expect(atRefresh).toEqual(['<secret:test.access-token> <secret:test.refresh-token>']);
    expect(atRequest).toEqual(['Bearer <secret:test.access-token>']);
    expect(processSecrets.redact(renewed.refresh)).toBe('<secret:test.refresh-token>');
  });
});
