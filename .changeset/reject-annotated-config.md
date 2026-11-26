---
'@e2e-dev/core': patch
'e2e': patch
---

Passing `typeof config` from an annotated config such as `const config: E2EConfig` to `test.extend` now fails with a type error. Write the config with `as const satisfies E2EConfig` or `defineConfig` instead so the target types are inferred. Before, that call compiled with plain `E2EConfig`. The config's engine fixtures weren't added, `platform` was typed as `string`, and fixtures already on `test` stayed typed on targets where they were `undefined`. A target spread from a value typed as `Target` fails the same way. Passing an explicit `unknown` or a generic type parameter as the config type (such as `function withAccount<C extends E2EConfig>()` calling `base.extend<{}, {}, C>()`) doesn't compile anymore.
