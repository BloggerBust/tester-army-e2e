/** A model call that failed before any request left because no credential was configured, named for what it is. */

import type { AiSdk, SdkLanguageModel } from '../ai-sdk.ts';
import { AgentError } from '../error.ts';

type Environment = Readonly<Record<string, string | undefined>>;

/** A name shaped like an environment variable, as a provider's message spells it. */
const VARIABLE_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

/**
 * The variable to set when `failure` was raised because nothing was
 * configured for the model to send; undefined when a configured credential
 * failed to load, was malformed, or was refused, which the provider's own
 * error describes better.
 *
 * The AI SDK's `loadApiKey` raises one error class for a missing key and for
 * a key that is not a string, and names the variable only in its text. So the
 * name is read there and held against the environment: the key is missing
 * only when that variable is undefined, since `loadApiKey` sends an empty one.
 *
 * The Vercel AI Gateway raises "No authentication provided" for every failure
 * to resolve a token, the real one in `cause`. Nothing was configured only
 * when resolution fell through to the OIDC token (the cause is its error) and
 * neither variable holds a value, an empty one counting as unset there. A
 * throwing `apiKey` callback, or a token that is set but expired or
 * malformed, is not this.
 */
export function unsetKeyVariable(failure: unknown, env: Environment = process.env): string | undefined {
  if (!(failure instanceof Error)) return undefined;
  if (failure.name === 'AI_LoadAPIKeyError') {
    const named = VARIABLE_NAME.exec(failure.message)?.[0];
    return named !== undefined && env[named] === undefined ? named : undefined;
  }
  if (failure.name !== 'GatewayAuthenticationError') return undefined;
  const fellThroughToOidc = failure.cause instanceof Error && failure.cause.name === 'VercelOidcTokenError';
  if (!fellThroughToOidc || env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN) return undefined;
  return 'AI_GATEWAY_API_KEY';
}

/** The provider error of a call that had no credential configured, as the middleware below rethrows it. */
class NoCredentialConfigured extends Error {
  constructor(variable: string, cause: unknown) {
    super(`the model has no credential: ${variable} is not set, so no request was sent. Set ${variable}, or pass the key where the model is constructed`, { cause });
    this.name = 'NoCredentialConfigured';
  }
}

/**
 * `MODEL_PROVIDER_FAILED` naming the unset variable, for a call
 * `withMissingCredentialNamed` found had no credential configured; undefined
 * for any other failure. The step that needed the model fails with it, as
 * with any provider failure. Built where the step catches the failure: the
 * stack of one built inside the SDK's call no longer reaches the test's line.
 */
export function missingCredentialError(failure: unknown): AgentError | undefined {
  if (!(failure instanceof NoCredentialConfigured)) return undefined;
  return new AgentError('MODEL_PROVIDER_FAILED', failure.message, { cause: failure.cause });
}

/**
 * `model` with a call that had no credential configured failing as an error
 * `missingCredentialError` reads. It sits under the SDK's own handling
 * because `ai` replaces every gateway authentication error with one text and
 * drops the cause, and no transport retry repeats an error raised here.
 */
export function withMissingCredentialNamed(ai: AiSdk, model: SdkLanguageModel): SdkLanguageModel {
  return ai.wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate();
        } catch (cause) {
          const variable = unsetKeyVariable(cause);
          throw variable === undefined ? cause : new NoCredentialConfigured(variable, cause);
        }
      },
    },
  });
}
