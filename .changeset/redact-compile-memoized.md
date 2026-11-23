---
"@e2e-dev/core": patch
---

Building the pattern that redacts a run's secrets is about 30 times faster, since each character's spellings are now worked out once per process instead of at every registration, and redacting process output that arrives in whole lines takes about 40% less time. What is redacted does not change.
