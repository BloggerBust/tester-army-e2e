---
'e2e': patch
---

Use `reporters: ['line']` or `--reporter line` to show running tests and completed results on one updating terminal row. Failure details print when each failure settles.

With a JSON reporter, `e2e explore` sends configuration and custom reporter logs to stderr so stdout contains a valid JSON report.
