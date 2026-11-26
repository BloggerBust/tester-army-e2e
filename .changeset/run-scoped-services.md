---
"@e2e-dev/core": patch
"e2e": patch
---

Add `services` to the config for dependencies of the app under test, like an email API or an OAuth provider. Services are started before app commands and stopped afterward during `e2e run` and `e2e explore`. Tests access them through the `services` fixture. `startupTimeout` and `shutdownTimeout` can be set on each service. `services` is now a built-in fixture name. An engine that contributes a `services` fixture fails to load, and a project fixture named `services` replaces the built-in one.
