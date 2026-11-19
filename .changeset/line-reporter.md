---
'e2e': patch
---

Use `--reporter line`, `reporters: ['line']`, or `line()` from `e2e/reporters` for a single updating progress row in an interactive terminal. The reporter prints failure details as soon as a test's final result is a failure or timeout.

With the `json` reporter, `e2e explore` now sends captured logs to stderr so you can pipe the JSON report on stdout to `jq`.
