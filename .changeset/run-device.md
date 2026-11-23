---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

Add `e2e run --device <name>` to run the selected mobile target on another simulator, emulator, or phone for one run, by name or id, over its `device` option: `e2e run --target ios --device 'iPad Pro 13-inch (M5)'`. With several mobile targets selected, pick one with `--target`. A `web()` target, or a target whose devices a provider leases, refuses the flag. An engine opts in with `selectsDevice: true` and reads the name from `EnginePrepareInfo.device`.
