/**
 * Credentials between runs: one JSON file keyed by provider id, mode 0600.
 * Writes hold an advisory lock and replace the file atomically, so two runs
 * writing at once neither tear the file nor lose each other's entries. A
 * refresh holds a lock for its login from its read to its write, so worker
 * processes send a rotating refresh token once between them, and it stores
 * the renewed tokens only while the login it read is still stored, so a
 * login or logout meanwhile stands.
 * `E2E_OAUTH_CREDENTIALS` holding the same JSON stands in for the file on a
 * machine the user cannot sign in on; that store refuses to write.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '../internal/file-lock.ts';
import { OAuthError } from './errors.ts';
import type { CredentialStore, OAuthCredentials } from './types.ts';

export const CREDENTIALS_ENV = 'E2E_OAUTH_CREDENTIALS';

type CredentialsFile = Record<string, OAuthCredentials>;

/** `$XDG_CONFIG_HOME/e2e/oauth.json`, or `~/.config/e2e/oauth.json`. */
export function defaultCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME'];
  const base = configHome !== undefined && configHome !== '' ? configHome : path.join(homedir(), '.config');
  return path.join(base, 'e2e', 'oauth.json');
}

/** The store the model constructors and the CLI use: the environment variable when set, else the file. */
export function defaultCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const fromEnv = env[CREDENTIALS_ENV];
  return fromEnv !== undefined && fromEnv !== '' ? new EnvCredentialStore(fromEnv) : new FileCredentialStore(defaultCredentialsPath(env));
}

const LOCK_WAIT_MS = 5_000;
/** A token request has no deadline of its own, so a waiter gives up on its own. */
const REFRESH_LOCK_WAIT_MS = 30_000;

export class FileCredentialStore implements CredentialStore {
  readonly path: string;

  constructor(file: string = defaultCredentialsPath()) {
    this.path = file;
  }

  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    const all = this.read();
    return all[storedKey(all, providerId)];
  }

  async set(providerId: string, credentials: OAuthCredentials): Promise<void> {
    await this.update((all) => ({ ...all, [storedKey(all, providerId)]: credentials }));
  }

  async remove(providerId: string): Promise<void> {
    await this.update((all) => Object.fromEntries(Object.entries(all).filter(([key]) => currentId(key) !== providerId)));
  }

  async replace(providerId: string, expected: OAuthCredentials, next: OAuthCredentials): Promise<boolean> {
    let replaced = false;
    await this.update((all) => {
      const key = storedKey(all, providerId);
      replaced = sameLogin(all[key], expected);
      return replaced ? { ...all, [key]: next } : all;
    });
    return replaced;
  }

  async list(): Promise<string[]> {
    return storedIds(this.read());
  }

  /** Runs `refresh` holding this login's lock file, so worker processes refresh it one at a time. */
  async exclusive<T>(providerId: string, refresh: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.path}.${storedKey(this.read(), providerId)}.refresh.lock`, REFRESH_LOCK_WAIT_MS, () => {
      const waited = `${REFRESH_LOCK_WAIT_MS / 1000} s`;
      const message = `another e2e process is still refreshing the ${providerId} login after ${waited}`;
      return new OAuthError('TIMEOUT', `${message}; run again once it finishes`);
    }, refresh);
  }

  private read(): CredentialsFile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw cause;
    }
    return parseCredentials(text, this.path);
  }

  /** Read-modify-write under the lock, then an atomic replace. */
  private async update(change: (all: CredentialsFile) => CredentialsFile): Promise<void> {
    const dir = path.dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Creation modes only apply to new paths; a directory or file that already existed keeps what it had unless told otherwise.
    chmodSync(dir, 0o700);
    const lockPath = `${this.path}.lock`;
    const busy = () => new Error(`${lockPath} is held by another process; remove it if that process is gone`);
    await withFileLock(lockPath, LOCK_WAIT_MS, busy, async () => {
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temp, `${JSON.stringify(change(this.read()), null, 2)}\n`, { mode: 0o600 });
      chmodSync(temp, 0o600);
      try {
        renameSync(temp, this.path);
      } catch (cause) {
        rmSync(temp, { force: true });
        throw cause;
      }
    });
  }
}

/** Credentials from the environment variable: readable everywhere, changed nowhere. */
export class EnvCredentialStore implements CredentialStore {
  private readonly entries: CredentialsFile;
  constructor(json: string, source: string = CREDENTIALS_ENV) {
    this.entries = parseCredentials(json, source);
  }
  async get(providerId: string): Promise<OAuthCredentials | undefined> {
    return this.entries[storedKey(this.entries, providerId)];
  }
  assertWritable(): never {
    throw new OAuthError('MISCONFIGURED', `${CREDENTIALS_ENV} is set, so logins come from the environment and cannot be changed here; unset it to sign in on this machine`);
  }
  async set(): Promise<void> {
    this.assertWritable();
  }
  async remove(): Promise<void> {
    return this.set();
  }
  async replace(_providerId: string, _expected: OAuthCredentials, _next: OAuthCredentials): Promise<boolean> {
    this.assertWritable();
  }
  async list(): Promise<string[]> {
    return storedIds(this.entries);
  }
  /** Each process holds its own copy of the variable, so there is nothing to share a refresh with. */
  async exclusive<T>(_providerId: string, refresh: () => Promise<T>): Promise<T> {
    return refresh();
  }
}

/** Keys an earlier release stored a login under, to the provider id that reads it now. Kept as is so that release still finds the login. */
const LEGACY_KEYS: ReadonlyMap<string, string> = new Map([['spacexai', 'spacexsi']]);

function currentId(key: string): string {
  return LEGACY_KEYS.get(key) ?? key;
}

function storedKey(all: CredentialsFile, providerId: string): string {
  if (Object.hasOwn(all, providerId)) return providerId;
  return Object.keys(all).find((key) => currentId(key) === providerId) ?? providerId;
}

function sameLogin(stored: OAuthCredentials | undefined, expected: OAuthCredentials): boolean {
  return stored !== undefined && stored.access === expected.access && stored.refresh === expected.refresh;
}

function storedIds(all: CredentialsFile): string[] {
  return [...new Set(Object.keys(all).map(currentId))];
}

/** The file's entries; one damaged entry is dropped rather than taking every login down with it. */
function parseCredentials(text: string, source: string): CredentialsFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} must hold an object keyed by provider id`);
  }
  const out: CredentialsFile = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isCredentials(value)) out[id] = value;
  }
  return out;
}

function isCredentials(value: unknown): value is OAuthCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['access'] === 'string' && typeof record['refresh'] === 'string' && typeof record['expires'] === 'number';
}
