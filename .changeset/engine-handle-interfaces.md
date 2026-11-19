---
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

A config that infers `web()` or `mobile()` type-checks again under pnpm with `declaration: true`. It failed with TS2883 since e2e 0.24.0. The factories now return `WebEngine` and `MobileEngine`, exported from each package.
