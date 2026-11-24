---
"@e2e-dev/core": minor
"e2e": minor
---

**Breaking:** The `requires` test option is removed; scope a test to targets with `platforms` instead. `{ requires: ['browser'] }` becomes `{ platforms: ['web'] }`, and `{ requires: ['device'] }` becomes `{ platforms: ['ios', 'android'] }`. A test, group, or setup that still sets `requires` fails at collection with a message naming `platforms`. The `Capability` type and the `capability-unavailable` skip cause in the report are gone with it, and `e2e init` with both engines now writes `platforms` into its example tests.
