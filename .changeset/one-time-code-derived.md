---
'@e2e-dev/core': patch
---

The replay cache now records a value typed into an `autocomplete="one-time-code"` field as a run-time gap, so a code typed one digit per box no longer replays the previous run's code.
