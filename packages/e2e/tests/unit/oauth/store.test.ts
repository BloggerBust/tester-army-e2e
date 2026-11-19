import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS_ENV, EnvCredentialStore, FileCredentialStore, defaultCredentialStore, defaultCredentialsPath } from '../../../src/oauth/store.ts';

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-oauth-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'oauth.json');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const creds = { access: 'a', refresh: 'r', expires: 123, accountId: 'acct' };

describe('FileCredentialStore', () => {
  it('creates the file with owner-only permissions and round-trips entries', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    expect(await store.get('spacexsi')).toBeUndefined();
    await store.set('spacexsi', creds);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(await store.get('spacexsi')).toEqual(creds);
    expect(await store.list()).toEqual(['spacexsi']);
    await store.remove('spacexsi');
    expect(await store.list()).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(() => statSync(`${file}.lock`)).toThrow();
  });

  it('reads a login an earlier release stored under a legacy key, and keeps it under that key so that release still finds it', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('openai', creds);
    writeFileSync(file, JSON.stringify({ spacexai: creds }));
    expect(await store.get('spacexsi')).toEqual(creds);
    expect(await store.list()).toEqual(['spacexsi']);
    await store.set('spacexsi', { ...creds, access: 'renewed' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ spacexai: { ...creds, access: 'renewed' } });
    await store.remove('spacexsi');
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
  });

  it('refreshes a login stored under a legacy key holding the lock an earlier release holds for it', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('openai', creds);
    writeFileSync(file, JSON.stringify({ spacexai: creds }));
    await store.exclusive('spacexsi', async () => {
      expect(statSync(`${file}.spacexai.refresh.lock`).isFile()).toBe(true);
      expect(() => statSync(`${file}.spacexsi.refresh.lock`)).toThrow();
    });
  });

  it('prefers the login under the id to one under its legacy key', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('openai', creds);
    writeFileSync(file, JSON.stringify({ spacexai: creds, spacexsi: { ...creds, access: 'newer' } }));
    expect(await store.get('spacexsi')).toEqual({ ...creds, access: 'newer' });
    expect(await store.list()).toEqual(['spacexsi']);
    await store.remove('spacexsi');
    expect(await store.list()).toEqual([]);
  });

  it('reads no login under a CLI alias, since no release stored one there', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('openai', creds);
    writeFileSync(file, JSON.stringify({ grok: creds }));
    expect(await store.get('spacexsi')).toBeUndefined();
  });

  it('keeps other providers when one is written, even from concurrent writers', async () => {
    const file = tempFile();
    const a = new FileCredentialStore(file);
    const b = new FileCredentialStore(file);
    await Promise.all([a.set('a', creds), b.set('b', { ...creds, access: 'b' }), a.set('c', { ...creds, access: 'c' })]);
    expect((await a.list()).toSorted()).toEqual(['a', 'b', 'c']);
    expect((await b.get('b'))?.access).toBe('b');
  });

  it('defers a writer while another process holds the lock', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, '');
    let settled = false;
    const pending = store.set('y', creds).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    rmSync(`${file}.lock`, { force: true });
    await pending;
    expect((await store.list()).toSorted()).toEqual(['x', 'y']);
  });

  it('tightens the permissions of a directory and file that already existed', async () => {
    const file = tempFile();
    const { mkdirSync, chmodSync } = await import('node:fs');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    writeFileSync(file, '{}', { mode: 0o644 });
    chmodSync(file, 0o644);
    await new FileCredentialStore(file).set('x', creds);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('takes over a stale lock left by a dead process', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(`${file}.lock`, '');
    const old = Date.now() / 1000 - 60;
    utimesSync(`${file}.lock`, old, old);
    await store.set('y', creds);
    expect((await store.list()).toSorted()).toEqual(['x', 'y']);
  });

  it('holds a lock for each login while it refreshes', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('a', creds);
    let finishA = () => {};
    const first = store.exclusive('a', () => new Promise<void>((resolve) => (finishA = resolve)));
    let enteredSecond = false;
    const second = store.exclusive('a', async () => {
      enteredSecond = true;
    });
    expect(await store.exclusive('b', async () => 'b')).toBe('b');
    expect(enteredSecond).toBe(false);
    finishA();
    await Promise.all([first, second]);
    expect(enteredSecond).toBe(true);
  });

  it('gives up with TIMEOUT after 30 s of another worker refreshing', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    const lock = `${file}.x.refresh.lock`;
    writeFileSync(lock, 'elsewhere.example 1 other');
    // Touched in the future, so the lock stays fresh however far the fake clock moves.
    const future = Date.now() / 1000 + 3_600;
    utimesSync(lock, future, future);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let settled = false;
      const pending = store.exclusive('x', async () => {}).finally(() => {
        settled = true;
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'TIMEOUT',
        message: 'another e2e process is still refreshing the x login after 30 s; run again once it finishes',
      });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a damaged entry instead of losing every login', async () => {
    const file = tempFile();
    const store = new FileCredentialStore(file);
    await store.set('x', creds);
    writeFileSync(file, JSON.stringify({ x: creds, broken: { access: 1 }, nan: { access: 'a', refresh: 'r', expires: null } }));
    expect(await store.list()).toEqual(['x']);
    expect(await store.get('broken')).toBeUndefined();
  });

  it('defaults to the XDG config directory', () => {
    expect(defaultCredentialsPath({ XDG_CONFIG_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/e2e/oauth.json');
    expect(defaultCredentialsPath({})).toMatch(/\.config\/e2e\/oauth\.json$/);
  });
});

describe('EnvCredentialStore', () => {
  it('is chosen when the variable is set, reads it, and refuses to change it', async () => {
    const store = defaultCredentialStore({ [CREDENTIALS_ENV]: JSON.stringify({ 'github-copilot': creds }) });
    expect(store).toBeInstanceOf(EnvCredentialStore);
    expect(await store.get('github-copilot')).toEqual(creds);
    expect(await store.list()).toEqual(['github-copilot']);
    await expect(store.set('spacexsi', creds)).rejects.toMatchObject({ code: 'MISCONFIGURED', message: expect.stringContaining(CREDENTIALS_ENV) });
    await expect(store.remove('github-copilot')).rejects.toMatchObject({ code: 'MISCONFIGURED' });
    expect(defaultCredentialStore({ [CREDENTIALS_ENV]: '' })).toBeInstanceOf(FileCredentialStore);
  });

  it('reads a login the variable holds under a legacy key', async () => {
    const store = defaultCredentialStore({ [CREDENTIALS_ENV]: JSON.stringify({ spacexai: creds }) });
    expect(await store.get('spacexsi')).toEqual(creds);
    expect(await store.list()).toEqual(['spacexsi']);
  });

  it('rejects malformed JSON naming the variable', () => {
    expect(() => new EnvCredentialStore('nope')).toThrow(new RegExp(`${CREDENTIALS_ENV} is not valid JSON`));
  });
});
