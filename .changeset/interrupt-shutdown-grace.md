---
"e2e": patch
---

A worker that finishes its test after an interrupt now gets the full shutdown budget to close its browser or device. Before, it was killed when the interrupt budget ran out, even mid cleanup.
