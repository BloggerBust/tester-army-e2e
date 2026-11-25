---
'@e2e-dev/mobile': patch
---

`@e2e-dev/mobile/lease` exports `installLeasedApp(request, lease)`, which installs the request's `appPath` through the lease's daemon and returns the lease with `installedApp`, for a device provider whose devices start without the build.
