---
'@e2e-dev/acp': patch
---

`codex()` signs Codex in with an OpenAI API key when Codex has no login of its own, so `OPENAI_API_KEY` alone starts the session instead of failing with "the agent is not signed in". It takes the first nonblank of `CODEX_API_KEY` and `OPENAI_API_KEY`, as the Codex adapter does, and leaves a nonblank `DEFAULT_AUTH_REQUEST` you set alone. Codex saves the key as its login, as `codex login --with-api-key` does, unless its credential store is `ephemeral`. While `APP_SERVER_LOGS` is set, `codex()` passes the adapter no sign-in request, yours included, since its log would write the credentials in plain text; a saved login still works. Codex's shell snapshots, which copied the environment with its keys to disk, are off too. When the model provider refuses Codex's credentials at a turn, the step now says how to recover, `codex logout` first for a saved login or key, instead of a bare `Authentication required`.
