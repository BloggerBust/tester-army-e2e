---
'e2e': patch
'@e2e-dev/core': patch
---

Added `expect(fn).toPass()` for retrying a block of assertions, with `.not` and `expect.soft` forms. `expect.poll` accepts a list of `intervals`, and its default pauses are now `[100, 250, 500, 1000]` ms. Defaults for `toPass` can be set with `toPass` in the config.

Deprecated: the `interval` option of `expect.poll`. Pass `intervals: [<ms>]`. It will be removed no earlier than April 1, 2027.
