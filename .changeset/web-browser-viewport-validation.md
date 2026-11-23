---
"@e2e-dev/web": patch
---

`web()` now throws `INVALID_CONFIG` at config load for a `browser` that is not `'chromium'`, `'firefox'`, `'webkit'`, or a provider, and for a `viewport` that is not `null` or `{ width, height }` in whole pixels, each at least 1. Before, any other browser name (`'Firefox'`, `'chrome'`) ran Chromium, and a malformed viewport failed every test with `ENGINE_FAILURE`.
