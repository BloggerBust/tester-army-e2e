---
"@e2e-dev/core": patch
"e2e": patch
---

Fix the "only 5 turns remain" notice reaching the model twice when the provider refused the turn's request (a forced tool choice it does not take, or a request too large) and the step sent it again.
