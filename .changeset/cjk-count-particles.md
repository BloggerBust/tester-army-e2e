---
'@e2e-dev/core': patch
---

The replay cache now also reads a CJK count followed by a particle, such as `42件を表示`, `42건이 검색되었습니다` or `42개는 품절`, as a count, so a growing tally no longer makes the next replay stale.
