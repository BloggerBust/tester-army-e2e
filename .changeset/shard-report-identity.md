---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/github": patch
---

A sharded run's report now records its shard as `run.shard { index, total }`, and marks each test this invocation's cut gave to another shard with `skip.otherShard: true`. A `--last-failed` rerun writes `report-with-reruns.json` beside its report: the first run and every rerun since as one report. It also hands its reporters every earlier run folded together as `lastRun`, through `foldLastRun`, now exported from `e2e`. The `@e2e-dev/github` comment after a second rerun no longer shows the first pass's passing tests as not run, and a second rerun keeps the first run's evidence on disk. The fold drops deleted tests and explains failures of out-of-shard consumers without counting them in the shard's totals. `@e2e-dev/github` now needs `e2e` 0.25.0 or later.
