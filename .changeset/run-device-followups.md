---
'e2e': patch
---

`e2e run --target web --device <name>` names only the `--target` selection in the run header before it fails with `UNSUPPORTED_CAPABILITY`, instead of every configured target. The `--device` docs now say which ids it takes (a simulator UDID or an emulator serial; any other value is a device name) and that it applies to the one selected target that can take a device while the other selected targets still run as configured.
