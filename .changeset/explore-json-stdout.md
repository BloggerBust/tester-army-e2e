---
'e2e': patch
---

Send what the config logs during `e2e explore` to stderr, redacted once the config's secrets are known, so `e2e explore --reporter json` emits valid JSON on stdout when the config prints during loading.
