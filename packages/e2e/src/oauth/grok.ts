/**
 * `grok('grok-4')`: a SuperGrok or X Premium+ subscription as an AI SDK
 * model. The instance is `@ai-sdk/xai`'s model with a fetch that carries the
 * stored login; the API is the ordinary SpaceXSI API.
 */

import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createXai } from '@ai-sdk/xai';
import { createOAuthFetch } from './fetch.ts';
import { withLogin } from './login-model.ts';
import { USER_AGENT } from '@e2e-dev/core/lib/internal/client-identity';
import { loginHint } from './providers.ts';
import { createXaiProvider } from './providers/xai.ts';
import { defaultCredentialStore } from './store.ts';

export function grok(modelId: string): LanguageModelV4 {
  const fetch = createOAuthFetch(createXaiProvider(), {
    store: defaultCredentialStore(),
    userAgent: USER_AGENT,
    loginHint: loginHint('spacexsi'),
  });
  return withLogin(createXai({ apiKey: 'oauth', fetch })(modelId), 'spacexsi');
}
