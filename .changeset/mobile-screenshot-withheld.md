---
"@e2e-dev/core": patch
"@e2e-dev/mobile": patch
"@e2e-dev/web": patch
"e2e": patch
---

On iOS and Android, when a secure field on screen has no bounds to mask, `toHaveScreenshot` now fails at once with `POLICY_DENIED` instead of after its timeout, `app.screenshot()` fails with `POLICY_DENIED` instead of `ENGINE_FAILURE`, and an agent step reports `MASKING_UNPROVEN` for its screenshot.
