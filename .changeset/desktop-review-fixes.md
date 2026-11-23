---
'@e2e-dev/desktop': patch
---

`desktop()` fixes. `e2e run --headed` launches the app in the foreground. `selectOption` refuses an editable combo box, `press` refuses a key agent-desktop cannot press, and a screenshot that cannot mask a password field fails with `POLICY_DENIED`. A read retries instead of passing as an empty screen, and keys and clicks no longer land on a control or window other than the one meant. `desktop()` returns `DesktopEngine`, so a config that infers its type declares under pnpm.
