/**
 * The `ai` peer range starts at 7.0.0, but the SDK exports
 * `ToolChoiceViolationError` only from 7.0.88. On an earlier release a
 * provider failure still translates to an agent error, and a refusal is
 * still recognized by the error's name.
 */

import { APICallError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { loadAiSdk } from '@e2e-dev/core/lib/agent/ai-sdk';
import { createModelAdapter, isModelRefusal } from '@e2e-dev/core/lib/agent/model/sdk';

// An undefined binding, as an ESM namespace reads a missing export; leaving
// the key out would make Vitest's mock proxy throw on the read instead.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  ToolChoiceViolationError: undefined,
}));

function failingModel(error: Error) {
  return {
    specificationVersion: 'v4',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5.5',
    supportedUrls: {},
    doGenerate: () => Promise.reject(error),
    doStream: () => Promise.reject(new Error('not called')),
  };
}

const call = {
  system: 'Judge the page.',
  prompt: 'Is the page right?',
  schemaName: 'verdict',
  schema: undefined,
  validate: (value: unknown) => ({ ok: true as const, value }),
  maxInputTokens: 64_000,
  maxOutputTokens: 1_000,
  signal: new AbortController().signal,
  timeoutMs: 5_000,
};

describe('an ai release without ToolChoiceViolationError', () => {
  it('is the precondition: the export is absent', async () => {
    expect((await loadAiSdk() as Record<string, unknown>)['ToolChoiceViolationError']).toBeUndefined();
  });

  it('fails a provider 400 as MODEL_PROVIDER_FAILED', async () => {
    const badRequest = new APICallError({
      isRetryable: false,
      message: 'Bad request',
      requestBodyValues: {},
      statusCode: 400,
      url: 'https://example.test',
    });
    const adapter = createModelAdapter({ provider: 'anthropic', id: 'claude-sonnet-5.5', model: failingModel(badRequest) as never });

    await expect(adapter.generate(call)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED', category: 'infrastructure' });
  });

  it('recognizes a tool choice refusal by name', async () => {
    await loadAiSdk();
    const violation = Object.assign(new Error('no tool call'), { name: 'AI_ToolChoiceViolationError', finishReason: 'content-filter' });

    expect(isModelRefusal(violation)).toBe(true);
    expect(isModelRefusal(Object.assign(violation, { finishReason: 'stop' }))).toBe(false);
  });
});
