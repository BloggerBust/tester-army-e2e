---
'@e2e-dev/core': patch
---

With `cache.strict`, a failed read of the cache directory (for example `EMFILE`) no longer turns off the check for steps recorded under another cache key for the rest of the worker. The next cache miss reads the directory again, so a stale recording fails with `REPLAY_STALE` instead of running the step live.
