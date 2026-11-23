---
"@e2e-dev/core": patch
---

A model provider failure on `ai` 7.0.0 to 7.0.87 now fails as `MODEL_PROVIDER_FAILED` instead of throwing `TypeError: Cannot read properties of undefined (reading 'isInstance')`. Those releases do not export `ToolChoiceViolationError`, which the refusal check read.
