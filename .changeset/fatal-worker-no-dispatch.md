---
"e2e": patch
---

A worker that hits an uncaught error no longer gets another test while it is being stopped. Before, that test could be skipped with "worker process exited before this test started" instead of running on another worker.
