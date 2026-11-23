---
'e2e': patch
'@e2e-dev/core': patch
---

`toHaveScreenshot` does less work per capture. A large `mask` box paints about 20 times faster, a capture identical to the stored screenshot compares about 5 times faster, and the diff image is drawn only for the failure that attaches it, not for every capture while it waits for a match. An engine protocol connection that has read everything it received no longer keeps the last message in memory until the next one arrives.
