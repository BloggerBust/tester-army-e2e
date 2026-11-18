---
'e2e': patch
'@e2e-dev/core': patch
---

`STEP_NOT_AWAITED` names the code that left the step running. A step call without `await` in a `beforeEach` hook, a fixture's setup, or a `beforeAll` or `afterAll` hook used to read `the test body returned before ...`. It now reads `the beforeEach hook returned before app.open "/" finished`, `the fixture "account" setup returned before ...`, or `the beforeAll hook returned before ...`. A session opened with `@e2e-dev/core` says `the hosted session`.
