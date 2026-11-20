---
'e2e': patch
'@e2e-dev/core': patch
---

Add `test.setTimeout(timeout)` to change the running test's timeout from its body or a `beforeEach` hook, or a `beforeAll` hook's own timeout.
