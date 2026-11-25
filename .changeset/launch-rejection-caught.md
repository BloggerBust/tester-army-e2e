---
"@e2e-dev/core": patch
"e2e": patch
---

A test that awaits `launch()` or `host.newSession()` and catches its error now passes. Before, the failed call still failed the test with `STEP_NOT_AWAITED` ("put `await` in front of it"), for example when the test opened a fresh session after `newSession({ state })` failed with `SESSION_EXPIRED`. `launch()` now checks its options before it opens, and a failed `launch()` or `newSession()` no longer counts as a call still running when the test ends. A call still running when the test ends still fails the test with `STEP_NOT_AWAITED`. One effect: a call that fails and is caught without `await`, such as `launch(web(), { bogus: true }).catch(() => {})`, failed the test before and now passes.
