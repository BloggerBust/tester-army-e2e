---
"@e2e-dev/core": patch
"e2e": patch
---

`e2e mcp` and `openHost` start the config's services. Sessions on the same config file share them. They're available in `run_code` and the `services` fixture.
