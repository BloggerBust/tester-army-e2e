---
"e2e": patch
---

A setup step that failed, such as an app command that exits before it is ready, now leaves the live window once its error is reported, instead of staying there as still starting until the run ends.
