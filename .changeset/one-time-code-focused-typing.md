---
"@e2e-dev/core": patch
---

A value the agent types into the focused field in a step whose screens listed an `autocomplete="one-time-code"` field is recorded as a `minted-token` gap, as a value typed into such a field already is, so the replay hands it to the agent instead of typing the last run's value.
