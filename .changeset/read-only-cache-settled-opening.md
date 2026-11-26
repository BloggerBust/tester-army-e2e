---
"@e2e-dev/core": patch
"e2e": patch
---

Fix an agent step that misses a read-only cache (the CI default) starting on a screen that had not held still. The step's first look now waits for the screen to settle, as it does with the cache off or read-write.
