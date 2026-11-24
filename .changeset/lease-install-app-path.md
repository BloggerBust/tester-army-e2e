---
'@e2e-dev/mobile': patch
---

`agentDeviceLeases()` takes `installAppPath`: once a lease is granted, it installs the request's `appPath` through that lease's own daemon and reports the app as `installedApp`, and a failed install releases the lease.
