---
'@e2e-dev/core': patch
'e2e': patch
---

A host whose session launch failed, and whose engine then could not end the attempt it opened, now closes for good, as one whose session close failed already does. Its next session is refused with `WORKER_PROTOCOL` instead of opening beside the leftover attempt. The cleanup failure comes back from `openHost`'s `host.close()`, and `launch()`'s `close()` throws it.
