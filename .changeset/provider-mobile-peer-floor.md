---
"@e2e-dev/limrun": patch
"@e2e-dev/revyl": patch
"@e2e-dev/testmu": patch
---

`@e2e-dev/revyl`, `@e2e-dev/testmu`, and `@e2e-dev/limrun` check that their agent-device matches the engine's, and they now pin agent-device 0.21.43, so they need `@e2e-dev/mobile` 0.12.10 or newer, the first release that runs it.
