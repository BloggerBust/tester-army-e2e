---
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'e2e': patch
'@e2e-dev/web': patch
---

Without a `session` option, two `mobile()` hosts from `launch()`, or a host and the test's own device, no longer drive one simulator under the same agent-device session. Each host hands its engine a random token as `hostId` in `prepare`, `init`, and `finish`, and the mobile engine names the host's session `e2e-<target>-<token>-<slot>`. `@e2e-dev/mobile` now needs `@e2e-dev/core` 0.24.1 or newer, the first release that sends `hostId`. A host that finds no free device now fails instead of sharing one. A host that ends without `close()` (`process.exit()`, a kill), or whose session fails to close, leaves its device held until you run `agent-device close --session <name>`; closing the host now fails with an error that names the session when the close fails. A host's artifact folders under `artifactsDir` are now named `core/host-<token>-<attempt id>`, so an engine platform that is a secret's value no longer reaches a path on disk.
