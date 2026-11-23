import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedConfig } from '@e2e-dev/core/lib/config/resolve';
import type { TargetSession } from '@e2e-dev/core/lib/engine/surface';
import type { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { serializeError, TestError } from '@e2e-dev/core/lib/internal/errors';
import { adoptSecrets, carriedSecrets, processSecrets, redactForSession, registerStaticSecrets, registerProviderKey, releaseSessionLedger, sessionLedger, shareStaticSecrets, staticSecretLedger } from '@e2e-dev/core/lib/run/secrecy';

const STATIC_VALUE = 'static-config-password-5521';
const PROVIDER_VALUE = 'provider-minted-token-8804';

const secrets: ResolvedConfig['secrets'] = new Map([
  ['password', { name: 'password', purpose: 'password', value: STATIC_VALUE }],
  ['token', { name: 'token', purpose: 'generic-secret', value: () => PROVIDER_VALUE }],
]);

const opened: TargetSession[] = [];

/** A fresh session key; the ledger is keyed by session identity only. Ended after its test, so what it knew is shared with no later one. */
function newSession(): TargetSession {
  const session = {} as unknown as TargetSession;
  opened.push(session);
  return session;
}

afterEach(() => {
  for (const session of opened.splice(0)) releaseSessionLedger(session);
});

describe('session secrecy carried across save and restore', () => {
  it('carries the provider values, leaving static values to each session', () => {
    const saving = sessionLedger(newSession(), secrets);
    saving.register('token', PROVIDER_VALUE);
    expect(carriedSecrets(saving, secrets)).toEqual([['token', PROVIDER_VALUE]]);
  });

  it('seeds the restoring session and the process ledger with the carried values', () => {
    const restoring = sessionLedger(newSession(), secrets);
    const value = 'provider-minted-token-adopted-2290';
    expect(processSecrets.redact(value)).toBe(value);
    adoptSecrets(restoring, [['token', value]]);
    expect(restoring.redact(`echo ${value}`)).toBe('echo <secret:token>');
    expect(processSecrets.redact(`log ${value}`)).toBe('log <secret:token>');
  });
});

describe('session download redaction', () => {
  it('vouches for downloads only when the ledger knows an app secret, its own or one from a session beside it', () => {
    const key = 'sk-test-session-download-53c5b339';
    registerProviderKey('OPENAI_API_KEY', key);
    const unsecret = sessionLedger(newSession(), new Map());
    expect(unsecret.redact(key)).toBe('<secret:OPENAI_API_KEY>');
    expect(unsecret.hasAppSecrets).toBe(false);
    const beside = newSession();
    expect(sessionLedger(beside, secrets).hasAppSecrets).toBe(true);
    // The app may hand the session a file holding what the one beside it typed.
    expect(unsecret.hasAppSecrets).toBe(true);
    releaseSessionLedger(beside);
    expect(unsecret.hasAppSecrets).toBe(false);
    unsecret.register('token', PROVIDER_VALUE);
    expect(unsecret.hasAppSecrets).toBe(true);
  });
});

describe('redaction before and after a session opens', () => {
  it('redacts the static values with no session, and every value the session learned once one is open', () => {
    expect(redactForSession(undefined, secrets, `title ${STATIC_VALUE}`)).toBe('title <secret:password>');
    // A provider value is not known before it resolves.
    expect(redactForSession(undefined, secrets, `title ${PROVIDER_VALUE}`)).toBe(`title ${PROVIDER_VALUE}`);
    const session = newSession();
    sessionLedger(session, secrets).register('token', PROVIDER_VALUE);
    expect(redactForSession(session, secrets, `${STATIC_VALUE} ${PROVIDER_VALUE}`)).toBe('<secret:password> <secret:token>');
  });

  it('keeps one static ledger per secrets map, untouched by what a session learns', () => {
    const ledger = staticSecretLedger(secrets);
    expect(staticSecretLedger(secrets)).toBe(ledger);
    sessionLedger(newSession(), secrets).register('token', PROVIDER_VALUE);
    expect(ledger.entries()).toEqual([['password', STATIC_VALUE]]);
  });

  it('makes the process ledger the default redactor once seeded, so a serialized error carries no secret', () => {
    const value = 'process-wide-ledger-value-3391';
    registerStaticSecrets(secrets);
    processSecrets.register('token', value);
    const serialized = serializeError(new TestError('ASSERTION_FAILED', `the app echoed ${value}`));
    expect(serialized.message).toBe('the app echoed <secret:token>');
  });
});

describe('secrets shared by the sessions in one process', () => {
  const none: ResolvedConfig['secrets'] = new Map();
  const one = (name: string, value: string): ResolvedConfig['secrets'] => new Map([[name, { name, purpose: 'generic-secret', value }]]);

  it('redacts a host\'s values in every session while they are shared, holds them in none, and stops once they are withdrawn', () => {
    const value = 'declared-by-a-host-4410';
    const before = sessionLedger(newSession(), none);
    const withdraw = shareStaticSecrets(one('invite', value));
    const after = sessionLedger(newSession(), none);
    for (const ledger of [before, after]) {
      expect(ledger.redact(`saw ${value}`)).toBe('saw <secret:invite>');
      // What a session holds stays its own: a saved state carries none of the host's values.
      expect(ledger.entries()).toEqual([]);
      expect(carriedSecrets(ledger, none)).toEqual([]);
      // A download of either session may hold the value, so it is rewritten.
      expect(ledger.hasAppSecrets).toBe(true);
    }
    expect(redactForSession(undefined, none, `label ${value}`)).toBe('label <secret:invite>');
    withdraw();
    expect(before.redact(`saw ${value}`)).toBe(`saw ${value}`);
    expect(after.redact(`saw ${value}`)).toBe(`saw ${value}`);
    // Text the process emits stays covered: the process ledger keeps every value it met.
    expect(processSecrets.redact(`log ${value}`)).toBe('log <secret:invite>');
  });

  it('shares a run\'s config values with every session for the life of the process', () => {
    const value = 'declared-by-the-run-9902';
    const before = sessionLedger(newSession(), none);
    registerStaticSecrets(one('run', value));
    expect(before.redact(value)).toBe('<secret:run>');
    expect(sessionLedger(newSession(), none).redact(value)).toBe('<secret:run>');
  });

  it('shares what a session learned with the sessions beside it, opened before or after, until the session ends', () => {
    const value = 'learned-mid-session-3317';
    const learning = newSession();
    const learner = sessionLedger(learning, none);
    const before = sessionLedger(newSession(), none);
    adoptSecrets(learner, [['code', value]]);
    const after = sessionLedger(newSession(), none);
    expect(before.redact(value)).toBe('<secret:code>');
    expect(after.redact(value)).toBe('<secret:code>');
    expect(before.entries()).toEqual([]);
    releaseSessionLedger(learning);
    // A one-time code is fresh on every fill: it leaves with its session, which still redacts it in what is reported of it.
    expect(before.redact(value)).toBe(value);
    expect(learner.redact(value)).toBe('<secret:code>');
  });

  it('reaches the sessions of another copy of the module, as a project with two installs loads', async () => {
    const mine = sessionLedger(newSession(), none);
    vi.resetModules();
    const copy = await import('@e2e-dev/core/lib/run/secrecy');
    expect(copy.processSecrets).not.toBe(processSecrets);
    const theirs = copy.sessionLedger(newSession(), none);

    const fromCopy = 'declared-in-the-other-copy-6120';
    const withdraw = copy.shareStaticSecrets(one('other', fromCopy));
    expect(mine.redact(fromCopy)).toBe('<secret:other>');
    expect(processSecrets.redact(fromCopy)).toBe('<secret:other>');
    withdraw();
    expect(mine.redact(fromCopy)).toBe(fromCopy);

    const fromHere = 'declared-in-this-copy-7245';
    registerStaticSecrets(one('here', fromHere));
    expect(theirs.redact(fromHere)).toBe('<secret:here>');
    expect(copy.processSecrets.redact(fromHere)).toBe('<secret:here>');
    // Each copy keeps its own ledgers: the other copy's session is ended through that copy.
    copy.releaseSessionLedger(opened.pop()!);
  });

  it('rebuilds a ledger only when a value appears or disappears, not when one more owner shares a value already there', () => {
    const compiled = (ledger: SecretLedger): unknown => Reflect.get(ledger, 'compiled');
    const config = one('token', 'shared-by-every-session-4471');
    registerStaticSecrets(config);
    const watching = sessionLedger(newSession(), none);
    watching.redact('warm');
    const built = compiled(watching);
    // A test's own session opens and ends with the run's config values, as every test does.
    const session = newSession();
    sessionLedger(session, config);
    releaseSessionLedger(session);
    watching.redact('again');
    expect(compiled(watching)).toBe(built);
    const withdraw = shareStaticSecrets(one('fresh', 'a-value-nobody-shared-9920'));
    expect(watching.redact('a-value-nobody-shared-9920')).toBe('<secret:fresh>');
    expect(compiled(watching)).not.toBe(built);
    withdraw();
  });
});
