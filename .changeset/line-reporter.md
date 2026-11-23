---
'e2e': patch
---

`--reporter line`, `reporters: ['line']`, or `line()` from `e2e/reporters` shows the run on one row. On a terminal the row names the test that started or finished last; piped or in CI, each test prints its row as it finishes. A failed test prints its failure details when its result arrives.

A setup test that is skipped no longer counts in the `Tests` total or in the `files` of the `collected` event: it never gets a result.
