---
"e2e": patch
---

Bring back `defineConfig` in `e2e`. It returns the config as it is, keeps its inferred type for `test.extend`, and makes an unknown top-level key a type error, as `satisfies E2EConfig` does.
