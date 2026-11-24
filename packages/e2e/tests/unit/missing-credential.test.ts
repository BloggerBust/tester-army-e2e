/** A model call with no credential configured fails as MODEL_PROVIDER_FAILED naming the unset variable, with no request sent; a configured credential that failed to load, was malformed, or was refused keeps the provider's own error. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, LoadAPIKeyError } from '@ai-sdk/provider';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGateway } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '@e2e-dev/core/lib/agent/error';
import { loadAiSdk, type SdkLanguageModel } from '@e2e-dev/core/lib/agent/ai-sdk';
import { missingCredentialError, unsetKeyVariable, withMissingCredentialNamed } from '@e2e-dev/core/lib/agent/model/missing-credential';
import { failureHint, isUnservedModelError } from '@e2e-dev/core/lib/agent/model/sdk';
import { createScriptedInstance } from '../helpers/scripted-model.ts';

/** What `loadApiKey` throws with no `apiKey` option and the variable undefined. */
function noKey(): LoadAPIKeyError {
  return new LoadAPIKeyError({ message: "OpenAI API key is missing. Pass it using the 'apiKey' parameter or the OPENAI_API_KEY environment variable." });
}

/** The gateway's error for a token it could not resolve, with the failure that stopped it as `cause`. */
function unresolvedGatewayToken(cause: unknown): Error {
  return Object.assign(new Error('AI Gateway authentication failed: No authentication provided.', { cause }), {
    name: 'GatewayAuthenticationError',
    statusCode: 401,
  });
}

/** What `@vercel/oidc` throws when it has no token and no linked project to fetch one for. */
function noOidcToken(): Error {
  return Object.assign(new Error("The 'x-vercel-oidc-token' header is missing from the request.\nproject.json not found, have you linked your project with `vc link?`"), {
    name: 'VercelOidcTokenError',
  });
}

/** A 401 from a provider that was sent a key. */
function refusedKey(): APICallError {
  return new APICallError({ message: 'Incorrect API key provided. Set OPENAI_API_KEY to a valid key.', url: 'https://api.openai.com/v1/responses', requestBodyValues: {}, statusCode: 401 });
}

describe('unsetKeyVariable', () => {
  it('names the variable the provider package reads when it is undefined', () => {
    expect(unsetKeyVariable(noKey(), {})).toBe('OPENAI_API_KEY');
  });

  it('does not call a variable unset when the provider package would have sent it', () => {
    // `loadApiKey` returns an empty variable as the key, so this text cannot have come from one.
    expect(unsetKeyVariable(noKey(), { OPENAI_API_KEY: '' })).toBeUndefined();
    const notAString = new LoadAPIKeyError({ message: 'OpenAI API key must be a string. The value of the OPENAI_API_KEY environment variable is not a string.' });
    expect(unsetKeyVariable(notAString, { OPENAI_API_KEY: 'sk-live-4242424242' })).toBeUndefined();
  });

  it('names none for a key that is not a string, whose message names no variable', () => {
    expect(unsetKeyVariable(new LoadAPIKeyError({ message: 'OpenAI API key must be a string.' }), {})).toBeUndefined();
  });

  it('names AI_GATEWAY_API_KEY when the gateway fell through to an OIDC token and neither variable holds a value', () => {
    expect(unsetKeyVariable(unresolvedGatewayToken(noOidcToken()), {})).toBe('AI_GATEWAY_API_KEY');
    // The gateway reads an empty variable as unset.
    expect(unsetKeyVariable(unresolvedGatewayToken(noOidcToken()), { AI_GATEWAY_API_KEY: '', VERCEL_OIDC_TOKEN: '' })).toBe('AI_GATEWAY_API_KEY');
  });

  it('names none for a gateway credential that was configured and failed to load, though the gateway words it the same', () => {
    expect(unsetKeyVariable(unresolvedGatewayToken(new Error('credential store offline')), {})).toBeUndefined();
    expect(unsetKeyVariable(unresolvedGatewayToken(new LoadAPIKeyError({ message: 'AI Gateway API key must be a non-empty string.' })), {})).toBeUndefined();
    expect(unsetKeyVariable(unresolvedGatewayToken(undefined), {})).toBeUndefined();
    const expired = Object.assign(new Error('\nFailed to refresh OIDC token: Unauthorized'), { name: 'VercelOidcTokenError' });
    expect(unsetKeyVariable(unresolvedGatewayToken(expired), { VERCEL_OIDC_TOKEN: 'a.b.c' })).toBeUndefined();
    expect(unsetKeyVariable(unresolvedGatewayToken(noOidcToken()), { AI_GATEWAY_API_KEY: ' ' })).toBeUndefined();
  });

  it('names none for a key the provider refused, whatever the environment holds', () => {
    const refusedByGateway = Object.assign(new Error('AI Gateway authentication failed: Invalid API key or token.'), { name: 'GatewayAuthenticationError', statusCode: 401 });
    expect(unsetKeyVariable(refusedByGateway, {})).toBeUndefined();
    expect(unsetKeyVariable(refusedKey(), {})).toBeUndefined();
  });

  it("names none for an error that is not the provider package's own, the same words included", () => {
    expect(unsetKeyVariable(new AgentError('ASSERTION_FAILED', 'the page shows "No authentication provided" and asks for OPENAI_API_KEY'), {})).toBeUndefined();
    expect(unsetKeyVariable(Object.assign(new Error('OPENAI_API_KEY is missing', { cause: noOidcToken() }), { statusCode: 401 }), {})).toBeUndefined();
    expect(unsetKeyVariable('OPENAI_API_KEY is missing', {})).toBeUndefined();
  });
});

describe('withMissingCredentialNamed, on real provider instances', () => {
  const cwd = process.cwd();
  const scratch: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(cwd);
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** One generate call on `model` behind the wrapper, resolving to what the call threw. */
  async function failureOf(model: unknown, maxRetries = 0): Promise<unknown> {
    const ai = await loadAiSdk();
    return ai.generateText({ model: withMissingCredentialNamed(ai, model as SdkLanguageModel), prompt: 'hi', maxRetries }).then(
      () => undefined,
      (cause: unknown) => cause,
    );
  }

  /** A fetch that fails the test's expectations when a request leaves, and counts the ones that do. */
  function countingFetch(status: number): { readonly fetch: typeof fetch; readonly calls: () => number } {
    let calls = 0;
    return {
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: 'No auth credentials found', code: status } }), { status, headers: { 'content-type': 'application/json' } });
      },
      calls: () => calls,
    };
  }

  it('names the unset variable for a provider package that found no key, without a request or a retry', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const sent = countingFetch(401);
    const failure = await failureOf(createOpenAI({ fetch: sent.fetch })('gpt-6-luna'), 5);
    const error = missingCredentialError(failure);
    expect(error).toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      category: 'infrastructure',
      message: 'the model has no credential: OPENAI_API_KEY is not set, so no request was sent. Set OPENAI_API_KEY, or pass the key where the model is constructed',
    });
    expect(error?.cause).toMatchObject({ name: 'AI_LoadAPIKeyError' });
    expect(isUnservedModelError(error)).toBe(false);
    expect(sent.calls()).toBe(0);
  });

  it('is asked once: no transport retry repeats a call with no credential', async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    let calls = 0;
    const failure = await failureOf(
      createScriptedInstance('scripted', 'keyless', async () => {
        calls += 1;
        throw noKey();
      }),
      5,
    );
    expect(missingCredentialError(failure)?.code).toBe('MODEL_PROVIDER_FAILED');
    expect(calls).toBe(1);
  });

  it("keeps the provider's message for an apiKey that is not a string", async () => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const failure = await failureOf(createOpenAI({ apiKey: 42 as never })('gpt-6-luna'));
    expect(failure).toMatchObject({ name: 'AI_LoadAPIKeyError', message: 'OpenAI API key must be a string.' });
    expect(missingCredentialError(failure)).toBeUndefined();
  });

  it('names OPENROUTER_API_KEY when it is undefined, and lets an empty one go out as the key OpenRouter refuses', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', undefined);
    const unset = countingFetch(401);
    expect(missingCredentialError(await failureOf(createOpenRouter({ fetch: unset.fetch })('openai/gpt-6-luna-fast')))).toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: expect.stringMatching(/^the model has no credential: OPENROUTER_API_KEY is not set/),
    });
    expect(unset.calls()).toBe(0);

    vi.stubEnv('OPENROUTER_API_KEY', '');
    const empty = countingFetch(401);
    const refused = await failureOf(createOpenRouter({ fetch: empty.fetch })('openai/gpt-6-luna-fast'));
    expect(empty.calls()).toBe(1);
    expect(missingCredentialError(refused)).toBeUndefined();
    expect(failureHint(refused)).toContain('the provider rejected the credential');
  });

  it('names AI_GATEWAY_API_KEY for a gateway with no key, no OIDC token, and no linked project', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', '');
    // @vercel/oidc looks for a linked project from the working directory up.
    const unlinked = mkdtempSync(path.join(tmpdir(), 'e2e-unlinked-'));
    scratch.push(unlinked);
    process.chdir(unlinked);
    const sent = countingFetch(401);
    const failure = await failureOf(createGateway({ fetch: sent.fetch })('openai/gpt-6-luna-fast'));
    expect(missingCredentialError(failure)).toMatchObject({
      code: 'MODEL_PROVIDER_FAILED',
      message: 'the model has no credential: AI_GATEWAY_API_KEY is not set, so no request was sent. Set AI_GATEWAY_API_KEY, or pass the key where the model is constructed',
    });
    expect(sent.calls()).toBe(0);
  });

  it.each([
    {
      credential: 'an apiKey callback that throws',
      env: {},
      options: {
        apiKey: async (): Promise<string> => {
          throw new Error('credential store offline');
        },
      },
    },
    { credential: 'an apiKey callback that returns nothing', env: {}, options: { apiKey: async (): Promise<string> => '' } },
    { credential: 'a malformed VERCEL_OIDC_TOKEN', env: { VERCEL_OIDC_TOKEN: 'a.b.c' }, options: {} },
  ])('leaves $credential to the gateway, which does not read it as an unset variable', async ({ env, options }) => {
    vi.stubEnv('AI_GATEWAY_API_KEY', '');
    vi.stubEnv('VERCEL_OIDC_TOKEN', env.VERCEL_OIDC_TOKEN ?? '');
    const sent = countingFetch(401);
    const failure = await failureOf(createGateway({ ...options, fetch: sent.fetch })('openai/gpt-6-luna-fast'));
    expect((failure as Error).name).toBe('GatewayAuthenticationError');
    expect(missingCredentialError(failure)).toBeUndefined();
    expect(sent.calls()).toBe(0);
  });
});
