---
"@e2e-dev/core": patch
"e2e": patch
---

Fix a cached agent step re-recording its flow when the replay ended in a scroll, the recorded end state did not show, and the model fixed it by scrolling further the same way. The entry is now evicted, as for any other repair after the replay ran in full.
