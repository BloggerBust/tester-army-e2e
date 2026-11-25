---
'@e2e-dev/core': patch
'e2e': patch
---

A test body or hook that kept running past its timeout can no longer act on the app during its own teardown or the next test. Its engine calls fail with `CANCELLED`, also when it makes them through a worker fixture.
