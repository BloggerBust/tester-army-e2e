---
'e2e': patch
'@e2e-dev/core': patch
---

A step that calls the model with no key configured now says so: `MODEL_PROVIDER_FAILED: the model has no credential: AI_GATEWAY_API_KEY is not set`, instead of the provider's `Unauthenticated request` text and a hint that the provider rejected a credential. It applies when a provider package finds no API key in its variable, or the Vercel AI Gateway finds neither a key nor an OIDC token. The step still fails as before (exit 3), and recorded `agent.act` steps and tests with no agent call still run. `e2e doctor` warns when a Vercel AI Gateway or OpenRouter model has no key variable set, and its last line counts the warnings.
