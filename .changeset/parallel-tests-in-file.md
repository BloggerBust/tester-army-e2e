---
'e2e': patch
'@e2e-dev/core': patch
---

Tests of one file can run at the same time on separate workers. `describe(title, { parallel: true }, fn)` does it for a group, `describe.configure({ parallel: true })` at the top of a file for the file, and `fullyParallel: true` in the config, on a target, or `--fully-parallel` for every file. A serial group still runs as one unit, and `{ parallel: false }` keeps a group or a file in order. A worker imports the file one time for the tests it runs apart, so they share the file's state on that worker and not across workers. Tests with `beforeAll` or `afterAll` hooks around them run in batches, at most as many as the target has workers for each agent, and each batch runs the hooks one time. The repeats of a test run one after another on one worker. With one worker, the default in CI, they still run one at a time. Without any of these, a file's tests run in order on one worker, as before.
