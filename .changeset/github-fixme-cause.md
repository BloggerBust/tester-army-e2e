---
'@e2e-dev/github': patch
---

After a rerun, the merged report counts a serial test that calls `test.fixme()` in its body as executed, as it does for `test.skip()`. The pull request comment does not change.
