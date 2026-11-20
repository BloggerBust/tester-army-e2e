---
'@e2e-dev/core': patch
---

The replay cache now also reads a CJK count followed by a copula, such as `42件です`, `42건입니다` or `42건이에요`, as a count, so a growing tally no longer makes the next replay stale.
