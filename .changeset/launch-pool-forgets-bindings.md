---
'@e2e-dev/mobile': patch
---

An engine's `finish` now forgets the devices it bound for the target, so a `mobile()` engine reused by one `launch()` host after another no longer keeps every finished host's device and daemon address.
