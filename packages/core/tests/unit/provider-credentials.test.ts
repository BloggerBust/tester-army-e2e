import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TargetSession } from '../../src/engine/surface.ts';
import { redactSecrets, registerProviderKey, registerProviderKeys } from '../../src/agent/public.ts';
import {
  carriedSecrets,
  processSecrets,
  redactProviderKeys,
  redactsDownloads,
  registerStaticSecrets,
  releaseSessionLedger,
  sessionLedger,
  staticOutputLedger,
  staticSecretLedger,
} from '../../src/run/secrecy.ts';

/** The variables model providers read their key from, whose values every ledger redacts. */
const PROVIDER_VARIABLES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AI_GATEWAY_API_KEY',
  'LLM_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'OPENROUTER_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'XAI_API_KEY',
  'OPENCODE_API_KEY',
] as const;

const NO_SECRETS = new Map();
const opened: TargetSession[] = [];

/** A fake key no earlier test registered, so what one test shares cannot answer for another. */
function fakeKey(): string {
  return `sk-test-${randomBytes(12).toString('hex')}`;
}

function newSession(): TargetSession {
  const session = {} as unknown as TargetSession;
  opened.push(session);
  return session;
}

beforeEach(() => {
  // The developer's own keys must not decide a test.
  for (const name of PROVIDER_VARIABLES) vi.stubEnv(name, undefined);
});

afterEach(() => {
  for (const session of opened.splice(0)) releaseSessionLedger(session);
  vi.unstubAllEnvs();
});

describe('provider credentials in the environment', () => {
  it.each(PROVIDER_VARIABLES)('redacts %s from session and process text as its own marker', (name) => {
    const key = fakeKey();
    vi.stubEnv(name, key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`provider said: bad key ${key}.`)).toBe(`provider said: bad key <secret:${name}>.`);
    expect(processSecrets.redact(`echo ${key}`)).toBe(`echo <secret:${name}>`);
  });

  it('redacts a key set in the environment before the run registers its secrets', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    registerStaticSecrets(NO_SECRETS);
    expect(processSecrets.redact(`rejected ${key}`)).toBe('rejected <secret:OPENAI_API_KEY>');
  });

  it('redacts the key as the provider uses it, without the spaces or line break around it', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', `  ${key}\n`);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`Bearer ${key}"`)).toBe('Bearer <secret:OPENAI_API_KEY>"');
  });

  it('redacts the key in the spellings a report or URL gives it', () => {
    const key = `${fakeKey()}/+=`;
    vi.stubEnv('ANTHROPIC_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`q=${encodeURIComponent(key)}`)).toBe('q=<secret:ANTHROPIC_API_KEY>');
    expect(ledger.redact(JSON.stringify({ message: key.toUpperCase() }))).toBe('{"message":"<secret:ANTHROPIC_API_KEY>"}');
  });

  it('redacts a key cut short at a length limit once half of it is there', () => {
    const key = fakeKey();
    expect(key).toHaveLength(32);
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redactCut(`credential ${key.slice(0, 16)}`)).toBe('credential <secret:OPENAI_API_KEY>');
    expect(ledger.redactCut(`credential ${key.slice(0, 15)}`)).toBe(`credential ${key.slice(0, 15)}`);
  });

  it('asks for at least 16 characters of a short key cut at a limit, more than its half', () => {
    const key = 'q7z9w3k1m5p8r2t6v0xy';
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redactCut(`credential ${key.slice(0, 16)}`)).toBe('credential <secret:OPENAI_API_KEY>');
    expect(ledger.redactCut(`credential ${key.slice(0, 15)}`)).toBe(`credential ${key.slice(0, 15)}`);
  });

  it('leaves text that ends with only the start every key of a provider shares', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-aaaa1111bbbb2222cccc3333dddd4444');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redactCut('Paste a key that starts with sk-proj-')).toBe('Paste a key that starts with sk-proj-');
  });

  it('still takes 8 characters of a secret of the run cut at a limit', () => {
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-2204');
    expect(ledger.redactCut('typed run-secr')).toBe('typed <secret:token>');
  });

  it.each(['ollama', 'lm-studio', 'sk-no-key-required', 'q7z9w3k1m5p8r2t6v0x'])('leaves the placeholder %s a local model server takes alone, so ordinary text is not rewritten', (placeholder) => {
    vi.stubEnv('OPENAI_API_KEY', placeholder);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`Open the ${placeholder} settings`)).toBe(`Open the ${placeholder} settings`);
  });

  it('redacts a key of exactly 20 characters, the shortest it takes for one', () => {
    vi.stubEnv('OPENAI_API_KEY', 'q7z9w3k1m5p8r2t6v0xy');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact('key q7z9w3k1m5p8r2t6v0xy.')).toBe('key <secret:OPENAI_API_KEY>.');
  });

  it('leaves an empty or blank variable alone', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '   ');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact('text with   spaces')).toBe('text with   spaces');
  });

  it('reads only the provider variables it names, not every variable that looks like a key', () => {
    const value = fakeKey();
    vi.stubEnv('E2E_PROBE_UNRELATED_SETTING', value);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(value)).toBe(value);
  });

  it('redacts a key set after an earlier session opened, in sessions opened later', () => {
    sessionLedger(newSession(), NO_SECRETS);
    const key = fakeKey();
    vi.stubEnv('XAI_API_KEY', key);
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:XAI_API_KEY>');
  });

  it('keeps redacting a key after the session that first saw it ends', () => {
    const key = fakeKey();
    vi.stubEnv('OPENROUTER_API_KEY', key);
    const first = newSession();
    sessionLedger(first, NO_SECRETS);
    releaseSessionLedger(first);
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
    expect(processSecrets.redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
  });
});

describe('provider credentials leave the rest of secrecy as it was', () => {
  it('turns on download rewriting: a config can give the app a key', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeKey());
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(process.env['OPENAI_API_KEY']!)).toBe('<secret:OPENAI_API_KEY>');
    expect(redactsDownloads(ledger)).toBe(true);
  });

  it('still rewrites downloads once the session holds a secret of the run', () => {
    vi.stubEnv('OPENAI_API_KEY', fakeKey());
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-9931');
    expect(redactsDownloads(ledger)).toBe(true);
  });

  it('does not carry a key into a saved session', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-4410');
    expect(carriedSecrets(ledger, NO_SECRETS)).toEqual([['token', 'run-secret-value-4410']]);
    expect(ledger.entries().some(([, value]) => value === key)).toBe(false);
  });

  it('lets a run secret that holds the key win the marker, so the run names it', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('apiKey', `${key}-suffix`);
    expect(ledger.redact(`${key}-suffix and ${key}`)).toBe('<secret:apiKey> and <secret:OPENAI_API_KEY>');
  });
});

describe('provider keys and the rest of redaction', () => {
  it('redacts a key from text this process alone writes before any session, such as a test filter note', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = staticOutputLedger(new Map());
    expect(ledger.redact(`note ${key}`)).toBe('note <secret:OPENAI_API_KEY>');
    expect(ledger.redactFragments(`diff ${key}`)).toBe('diff <secret:OPENAI_API_KEY>');
  });

  it('builds that ledger once per config, with the config\'s own secrets in it', () => {
    const secrets = new Map([['password', { name: 'password', purpose: 'password', value: 'config-secret-value-7719' }]]) as never;
    expect(staticOutputLedger(secrets)).toBe(staticOutputLedger(secrets));
    expect(staticOutputLedger(secrets).redact('config-secret-value-7719')).toBe('<secret:password>');
  });

  it('leaves a key in what a test id is made of, which the runner and a worker must redact alike whatever keys each knows', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    registerProviderKey('agent.worker-only', `${key}-worker`);
    const ledger = staticSecretLedger(new Map());
    expect(ledger.redact(`title ${key} ${key}-worker`)).toBe(`title ${key} ${key}-worker`);
  });

  it('rewrites a key in a download whole, beside a secret of the run, and leaves a part of one alone', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-7702');
    expect(ledger.redactFragments(`export run-secret-value-7702 ${key}`)).toBe('export <secret:token> <secret:OPENAI_API_KEY>');
    expect(ledger.redactFragments(`prefix ${key.slice(0, 12)} only`)).toBe(`prefix ${key.slice(0, 12)} only`);
  });

  it('matches a key whole, never in part: keys of one provider share a prefix', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-proj-shared-prefix-aaaa1111bbbb2222');
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('token', 'run-secret-value-6613');
    const other = 'sk-proj-shared-prefix-cccc3333dddd4444';
    expect(ledger.redactFragments(`diff ${other} secret-value-66`)).toBe(`diff ${other} <secret:token>`);
    expect(ledger.redactFragments('sk-proj-shared-prefix-aaaa1111bbbb2222')).toBe('<secret:OPENAI_API_KEY>');
  });

  it('keeps a key that is also a secret of the run as that secret: named by the run, and rewritten in downloads', () => {
    const key = fakeKey();
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    ledger.register('apiKey', key);
    expect(ledger.redact(key)).toBe('<secret:apiKey>');
    expect(redactsDownloads(ledger)).toBe(true);
    expect(ledger.redactFragments(key)).toBe('<secret:apiKey>');
  });
});

describe('what an executor registers and redacts', () => {
  it('redacts a key an executor registers, trimmed, under the name it gave', () => {
    const key = fakeKey();
    expect(redactSecrets(key)).toBe(key);
    registerProviderKey('agent.saved-key', ` ${key}\n`);
    expect(redactSecrets(`quoted ${key}`)).toBe('quoted <secret:agent.saved-key>');
    expect(sessionLedger(newSession(), NO_SECRETS).redact(key)).toBe('<secret:agent.saved-key>');
  });

  it('redacts only provider keys with redactProviderKeys, not a value a session learned', () => {
    const key = fakeKey();
    registerProviderKey('agent.prompt-key', key);
    processSecrets.register('earlier.pin', 'order-7c3e9a41b2');
    expect(redactProviderKeys(`use ${key} for order-7c3e9a41b2`)).toBe('use <secret:agent.prompt-key> for order-7c3e9a41b2');
    expect(redactSecrets('order-7c3e9a41b2')).toBe('<secret:earlier.pin>');
  });

  it('leaves a registered value shorter than 20 characters alone, and takes one of exactly 20', () => {
    registerProviderKey('agent.short', 'zq7k2w9d4h6j1n3b5c8');
    registerProviderKey('agent.shortest', 'zq7k2w9d4h6j1n3b5c8f');
    expect(redactSecrets('zq7k2w9d4h6j1n3b5c8, zq7k2w9d4h6j1n3b5c8f')).toBe('zq7k2w9d4h6j1n3b5c8, <secret:agent.shortest>');
  });

  it.each(['', 'has space', 'a>b', 'tab\tname', 'ünïcode'])('refuses the name %j, which a marker cannot spell', (name) => {
    expect(() => registerProviderKey(name, fakeKey())).toThrow(new TypeError(`registerProviderKey: the name ${JSON.stringify(name)} must be letters, digits, "_", ".", or "-"`));
  });

  it('takes a name of letters, digits, underscores, dots, and dashes', () => {
    const key = fakeKey();
    registerProviderKey('Agent_1.saved-key', key);
    expect(redactSecrets(key)).toBe('<secret:Agent_1.saved-key>');
  });

  it('registers the provider keys of an environment an agent starts with, and no other variable of it', () => {
    const key = fakeKey();
    const other = fakeKey();
    registerProviderKeys({ ANTHROPIC_API_KEY: key, PATH: other, OPENAI_API_KEY: undefined });
    expect(redactSecrets(`${key} ${other}`)).toBe(`<secret:ANTHROPIC_API_KEY> ${other}`);
  });

  it('redacts the secrets of the run too, for text an executor cuts before returning it', () => {
    registerStaticSecrets(new Map([['password', { name: 'password', purpose: 'password', value: 'run-secret-value-1187' }]]));
    expect(redactSecrets('typed run-secret-value-1187')).toBe('typed <secret:password>');
  });
});

describe('a verdict summary that is cut to its limit', () => {
  it('is redacted before the cut, so a key across the limit leaves no part of itself', async () => {
    const { validateVerdict } = await import('../../src/agent/act-validation.ts');
    const key = fakeKey();
    registerProviderKey('agent.key', key);
    // The key starts 10 characters before the 2000-character limit.
    const summary = `  ${'x'.repeat(1990)}${key} and more  `;
    const verdict = validateVerdict({ status: 'failed', summary }, 'probe', redactSecrets);
    expect(verdict.summary).toBe(`${'x'.repeat(1990)}<secret:ag`);
    expect(verdict.summary).not.toContain(key.slice(0, 10));
  });
});

describe('the ledger and what is beside it', () => {
  it('stands alone with nothing beside it', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const ledger = new SecretLedger([['token', 'alone-secret-value-3391']]);
    expect(ledger.redact('alone-secret-value-3391')).toBe('<secret:token>');
    expect(ledger.redactsAnything).toBe(true);
    expect(ledger.redactFragments('secret-value-33')).toBe('<secret:token>');
    expect(ledger.redact('plain text stays as written')).toBe('plain text stays as written');
    expect(new SecretLedger().redactsAnything).toBe(false);
  });

  it('rewrites downloads from the moment a session beside it holds a secret, before it redacts anything else', () => {
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redactFragments('adjacent-ledger-token-8812')).toBe('adjacent-ledger-token-8812');
    sessionLedger(newSession(), new Map([['beside', { name: 'beside', purpose: 'generic-secret', value: 'adjacent-ledger-token-8812' }]]) as never);
    expect(redactsDownloads(ledger)).toBe(true);
    expect(ledger.redactFragments('adjacent-ledger-token-8812')).toBe('<secret:beside>');
  });

  it('keeps two secrets apart whose name and value run together to the same text', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const ledger = new SecretLedger([
      ['tok', 'enA-shared-value-1'],
      ['toke', 'nA-shared-value-1'],
    ]);
    expect(ledger.redact('enA-shared-value-1')).toBe('<secret:tok>');
    expect(ledger.redactFragments('enA-shared-value-1')).toBe('<secret:tok>');
  });

  it('sees a key and a shared secret that arrive together after it last redacted', () => {
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    const key = fakeKey();
    expect(ledger.redact(key)).toBe(key);
    registerProviderKey('agent.late-key', key);
    sessionLedger(newSession(), new Map([['late', { name: 'late', purpose: 'generic-secret', value: 'late-shared-secret-5540' }]]) as never);
    expect(ledger.redact(`${key} late-shared-secret-5540`)).toBe('<secret:agent.late-key> <secret:late>');
  });

  it('sees a key registered after the static ledger last redacted', () => {
    const ledger = staticOutputLedger(new Map());
    const key = fakeKey();
    expect(ledger.redact(key)).toBe(key);
    registerProviderKey('agent.later-key', key);
    expect(ledger.redact(key)).toBe('<secret:agent.later-key>');
  });

  it('keeps the keys where another copy of the package in the process finds them', () => {
    registerProviderKey('agent.shared-slot', fakeKey());
    expect(Object.getOwnPropertySymbols(globalThis)).toContain(Symbol.for('e2e.providerKeys.v1'));
  });
});

describe('a process that has loaded no config yet', () => {
  it('redacts the keys of its environment, and its errors, from the moment the module loads', async () => {
    const key = fakeKey();
    vi.stubEnv('OPENROUTER_API_KEY', key);
    const errors = await import('../../src/internal/errors.ts');
    errors.setErrorRedactor(undefined);
    vi.resetModules();
    const fresh = await import('../../src/run/secrecy.ts');
    expect(fresh.processSecrets.redact(key)).toBe('<secret:OPENROUTER_API_KEY>');
    const serialized = errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', `config threw: ${key}`));
    expect(serialized.message).toBe('config threw: <secret:OPENROUTER_API_KEY>');
    const later = fakeKey();
    vi.stubEnv('MISTRAL_API_KEY', later);
    expect(errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', `then: ${later}`)).message).toBe('then: <secret:MISTRAL_API_KEY>');
  });

  it('leaves the error redactor another copy of the package installed, which knows values this copy does not', async () => {
    const errors = await import('../../src/internal/errors.ts');
    errors.setErrorRedactor((text) => text.replaceAll('first-copy-value', '<secret:first>'));
    vi.resetModules();
    await import('../../src/run/secrecy.ts');
    const serialized = errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', 'quoted first-copy-value'));
    expect(serialized.message).toBe('quoted <secret:first>');
    errors.setErrorRedactor(undefined);
  });
});

describe('a value too long to be a key', () => {
  /** A token in the shape of a JWT, `length` characters long. */
  const tokenOf = (length: number) => `eyJhbGciOiJSUzI1NiJ9.${randomBytes(length).toString('base64url')}`.slice(0, length);

  it('redacts a token of exactly the most characters it takes', () => {
    const token = tokenOf(8192);
    registerProviderKey('agent.longest-token', token);
    expect(redactSecrets(`quoted ${token}.`)).toBe('quoted <secret:agent.longest-token>.');
  });

  it('leaves a longer value alone, and goes on redacting the others', () => {
    const tooLong = tokenOf(8193);
    const key = fakeKey();
    registerProviderKey('agent.too-long', tooLong);
    registerProviderKey('agent.beside-too-long', key);
    expect(redactSecrets(tooLong)).toBe(tooLong);
    expect(redactSecrets(key)).toBe('<secret:agent.beside-too-long>');
  });

  it('leaves a value far past what a pattern can hold alone, where registering it would stop the run', () => {
    vi.stubEnv('VERCEL_OIDC_TOKEN', tokenOf(40_000));
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact('plain text')).toBe('plain text');
  });

  it('ignores a value that is no string, as an unset variable is in a config', () => {
    registerProviderKey('agent.unset', undefined);
    expect(redactSecrets('undefined stays as written')).toBe('undefined stays as written');
  });

  it('never quotes a secret in the error for values no pattern can hold', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const huge = randomBytes(40_000).toString('hex');
    const ledger = new SecretLedger([
      ['huge', huge],
      ['token', 'beside-huge-secret-5521'],
    ]);
    let thrown: unknown;
    try {
      ledger.redact('text');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toEqual(new Error('the secret values are too long to redact: shorten the longest secret, or take it out of the run'));
    expect(String((thrown as Error).stack)).not.toContain(huge.slice(0, 16));
    expect(String((thrown as Error).stack)).not.toContain('beside-huge');
  });
});

describe('an error reported before any session', () => {
  it('goes through this process\'s secrets once a run registers them, whatever redactor was installed before', async () => {
    const errors = await import('../../src/internal/errors.ts');
    errors.setErrorRedactor((text) => text);
    registerStaticSecrets(new Map([['password', { name: 'password', purpose: 'password', value: 'run-secret-value-6642' }]]) as never);
    expect(errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', 'typed run-secret-value-6642')).message).toBe('typed <secret:password>');
  });

  it('is redacted for a key the config set itself before it failed', async () => {
    const errors = await import('../../src/internal/errors.ts');
    registerStaticSecrets(NO_SECRETS);
    const key = fakeKey();
    // What `process.loadEnvFile()` in a config does, after every earlier look at the environment.
    vi.stubEnv('GROQ_API_KEY', key);
    const serialized = errors.serializeError(new errors.ConfigurationError('INVALID_CONFIG', `config threw: ${key}`));
    expect(serialized.message).toBe('config threw: <secret:GROQ_API_KEY>');
  });
});

describe('large patterns in the secret ledger', () => {
  it('redacts a long punctuation-heavy value in Latin-1 and Unicode text', async () => {
    const { SecretLedger } = await import('../../src/internal/redact.ts');
    const value = '-'.repeat(1200);
    const ledger = new SecretLedger([['dashes', value]]);
    expect(ledger.redact(`a ${value} b`)).toBe('a <secret:dashes> b');
    expect(ledger.redact(`ż ${value} ✓`)).toBe('ż <secret:dashes> ✓');
  });

  it('leaves a provider key no pattern can be built for alone, and the run goes on', () => {
    const unbuildable = '-'.repeat(3000);
    const key = fakeKey();
    vi.stubEnv('VERCEL_OIDC_TOKEN', unbuildable);
    vi.stubEnv('OPENAI_API_KEY', key);
    const ledger = sessionLedger(newSession(), NO_SECRETS);
    expect(ledger.redact(`${key} plain`)).toBe('<secret:OPENAI_API_KEY> plain');
    // Asked again, as every later look at the environment does.
    expect(sessionLedger(newSession(), NO_SECRETS).redact(`${key} plain`)).toBe('<secret:OPENAI_API_KEY> plain');
  });
});
