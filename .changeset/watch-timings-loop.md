---
"e2e": patch
---

`e2e run --watch --timings <file>` no longer reruns itself in a loop when the timings file sits inside a watched directory: the watcher now ignores the file the run writes, like the output and cache directories.
