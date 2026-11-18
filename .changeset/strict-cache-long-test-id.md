---
'e2e': patch
'@e2e-dev/core': patch
---

`--strict-cache` no longer fails with `REPLAY_STALE` a never-recorded step whose test id, target, or agent name is over 300 characters and starts like a recorded one.
