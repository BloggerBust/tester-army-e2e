/**
 * Every variable the model provider docs tell a user to put a key in is one
 * the run redacts. The list in core is closed, so a provider added to the
 * docs must be added to it, or named here as holding no key.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { processSecrets, registerProviderKeys } from '../../src/run/secrecy.ts';

/** The docs snippet, found from this file upward: a mutation run copies the package somewhere deeper. */
function snippet(): string {
  for (let directory = dirname(fileURLToPath(import.meta.url)); ; directory = dirname(directory)) {
    const candidate = join(directory, 'docs', 'snippets', 'model-provider.jsx');
    if (existsSync(candidate)) return candidate;
    if (directory === dirname(directory)) throw new Error('docs/snippets/model-provider.jsx was not found above this test');
  }
}

const SNIPPET = snippet();

/** Documented variables that hold no key the provider is sent: where to call, or which account. */
const NOT_KEYS = new Set([
  // A JSON service key and a path to one: neither is sent to the provider as written.
  'AICORE_SERVICE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'AWS_REGION',
  'AZURE_API_ENDPOINT',
  'AZURE_RESOURCE_NAME',
  'GOOGLE_VERTEX_LOCATION',
  'GOOGLE_VERTEX_PROJECT',
  'INFERENCE_URL',
  'NEON_AI_GATEWAY_BASE_URL',
]);

/** The variables each provider's docs entry names. */
function documented(): string[] {
  const source = readFileSync(SNIPPET, 'utf8');
  const names = [...source.matchAll(/env: \[([^\]]*)\]/g)].flatMap((match) => [...(match[1] ?? '').matchAll(/'([A-Z0-9_]+)'/g)].map((name) => name[1] ?? ''));
  return [...new Set(names)].toSorted();
}

describe('the provider key variables the run redacts', () => {
  it('reads the variables from the docs', () => {
    expect(documented().length).toBeGreaterThan(40);
    expect(documented()).toContain('OPENAI_API_KEY');
  });

  it.each(documented().filter((name) => !NOT_KEYS.has(name)))('redacts the key in %s', (name) => {
    const key = `key-for-${name.toLowerCase()}-0123456789`;
    registerProviderKeys({ [name]: key });
    expect(processSecrets.redact(`rejected ${key}`)).toBe(`rejected <secret:${name}>`);
  });

  it.each(['ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'LLM_API_KEY', 'OPENCODE_API_KEY', 'VERCEL_OIDC_TOKEN'])('redacts the key in %s, which a coding agent, a gateway, or `e2e init` reads', (name) => {
    const key = `key-for-${name.toLowerCase()}-0123456789`;
    registerProviderKeys({ [name]: key });
    expect(processSecrets.redact(key)).toBe(`<secret:${name}>`);
  });

  it.each([...NOT_KEYS])('leaves %s alone', (name) => {
    const value = `value-of-${name.toLowerCase()}-0123456789`;
    registerProviderKeys({ [name]: value });
    expect(processSecrets.redact(value)).toBe(value);
  });

  it('names no variable the docs do not', () => {
    expect([...NOT_KEYS].filter((name) => !documented().includes(name))).toEqual([]);
  });
});
