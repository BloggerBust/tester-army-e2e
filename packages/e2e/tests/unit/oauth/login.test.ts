import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { EnvCredentialStore, FileCredentialStore } from '../../../src/oauth/store.ts';
import { createOAuthFetch } from '../../../src/oauth/fetch.ts';
import { login, logout } from '../../../src/oauth/login.ts';
import { getProvider } from '../../../src/oauth/providers.ts';
import type { OAuthCredentials } from '../../../src/oauth/types.ts';
import { json, useServers } from '../../helpers/recording-server.ts';
import { MemoryCredentialStore } from './helpers/store.ts';

describe('logout', () => {
  it('reports whether a login was stored and writes nothing when there was none', async () => {
    const store = new MemoryCredentialStore({ spacexsi: { access: 'a', refresh: 'r', expires: 0 } });
    expect(await logout('openai', store)).toBe(false);
    expect(await logout('spacexsi', store)).toBe(true);
    expect(await store.list()).toEqual([]);
    // A read-only source is not asked to remove what it does not hold.
    expect(await logout('openai', new EnvCredentialStore('{}'))).toBe(false);
  });
});

describe('login', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const credentials = { access: 'local-test', refresh: 'local-refresh', expires: 0 };
  const callbacks = { onAuth: vi.fn(), onPrompt: async () => '' };

  it('refuses an explicit environment store before starting provider authentication', async () => {
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    await expect(login('github-copilot', { callbacks, store: new EnvCredentialStore('{}') })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('refuses the default environment store before starting provider authentication', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    await expect(login('github-copilot', { callbacks })).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('still authenticates and saves to a supplied writable store with an environment override', async () => {
    vi.stubEnv('E2E_OAUTH_CREDENTIALS', '{}');
    const authenticate = vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(credentials);
    const store = new MemoryCredentialStore();
    await expect(login('github-copilot', { callbacks, store })).resolves.toEqual(credentials);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(await store.get('github-copilot')).toEqual(credentials);
  });
});

describe('login and logout during a refresh', () => {
  const serve = useServers(afterEach);
  afterEach(() => { vi.restoreAllMocks(); });
  const callbacks = { onAuth: vi.fn(), onPrompt: async () => '' };
  const old = { access: 'old', refresh: 'old-refresh', expires: 1 };
  const signedIn = { access: 'new-account', refresh: 'new-refresh', expires: 0 };

  /** A file store holding an expired login, and a request that has started refreshing it and waits on `finish`. */
  async function refreshInFlight() {
    const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-login-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const store = new FileCredentialStore(path.join(dir, 'oauth.json'));
    await store.set('github-copilot', old);
    const api = await serve((_request, response) => json(response, 200, {}));
    let finish!: (credentials: OAuthCredentials) => void;
    let started!: () => void;
    const refreshing = new Promise<void>((resolve) => (started = resolve));
    const provider = {
      id: 'github-copilot',
      name: 'GitHub Copilot',
      login: async () => old,
      refresh: () => {
        started();
        return new Promise<OAuthCredentials>((resolve) => (finish = resolve));
      },
    };
    const request = createOAuthFetch(provider, { store, userAgent: 'p' })(api.url);
    await refreshing;
    return { store, request, finish: (credentials: OAuthCredentials) => finish(credentials) };
  }

  it('keeps the new login over the credentials the refresh renews', async () => {
    const { store, request, finish } = await refreshInFlight();
    vi.spyOn(getProvider('github-copilot'), 'login').mockResolvedValue(signedIn);
    await login('github-copilot', { callbacks, store });
    finish({ access: 'old-renewed', refresh: 'old-refresh-2', expires: Date.now() + 3_600_000 });
    await request;
    expect(await store.get('github-copilot')).toEqual(signedIn);
  });

  it('keeps the login removed when the refresh finishes after logout', async () => {
    const { store, request, finish } = await refreshInFlight();
    expect(await logout('github-copilot', store)).toBe(true);
    finish({ access: 'old-renewed', refresh: 'old-refresh-2', expires: Date.now() + 3_600_000 });
    await request;
    expect(await store.get('github-copilot')).toBeUndefined();
  });
});
