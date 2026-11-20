---
"@e2e-dev/core": patch
---

The `waitedMs` of a `LOCATOR_NOT_FOUND` is now counted from the moment the step's timeout started. It was counted from a later clock read, so a wait that ran its whole timeout could report 1 ms less, such as `Waited: 399ms` on a 400 ms timeout.
