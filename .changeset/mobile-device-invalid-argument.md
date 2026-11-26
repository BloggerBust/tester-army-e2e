---
'@e2e-dev/mobile': patch
---

`device.installApp(path)` with nothing at the path, and `device.setLocation()` with a latitude outside -90 to 90, a longitude outside -180 to 180, or a coordinate that is not a finite number, now fail with `INVALID_ARGUMENT` (a test error, exit 1) before any device command. Both used to fail as `ENGINE_FAILURE` and exit 3, like a broken device.
