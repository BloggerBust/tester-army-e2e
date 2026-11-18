---
'@e2e-dev/core': patch
---

The replay cache now reads counts written with a CJK counter (`42件`, `42个`, `42개`) the way it reads `42 items`, so a growing tally no longer makes the next replay stale.
