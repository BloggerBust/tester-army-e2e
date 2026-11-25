---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

Accept `app.permissions: 'all'` to grant every permission the target's engine can grant before each fresh launch: on Android every runtime permission the app declares, on an iOS simulator every privacy service its runtime can set, with location `always` (the simulator refuses notifications, so accept that prompt with `device.alert('accept')`), and on the web every permission the browser grants. `device.openApp(app, { relaunch: true, permissions: 'all' })` does the same for one launch.

An engine opts in with `grantsAllPermissions: true` and receives `EngineAppInfo.allPermissions: true`, so `EngineAppInfo.permissions` stays a map of names. For an engine that does not declare it, including a `@e2e-dev/web` or `@e2e-dev/mobile` released before this change, config load refuses `'all'` with `INVALID_CONFIG`.
