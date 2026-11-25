---
"@e2e-dev/core": patch
"e2e": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

An engine fixture is now `undefined` on a target whose engine doesn't have it, so a test with `device` can be run on web. Before, the run failed with `COLLECTION_ERROR`. The fixtures of every target are typed with the config's type as the third type argument: `test.extend<{}, {}, typeof config>()`, with `as const satisfies E2EConfig` on the config object. With `platforms` on a test, its fixtures are typed for the targets that run it.
