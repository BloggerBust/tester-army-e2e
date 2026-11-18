---
'@e2e-dev/core': patch
---

When an engine server started with `spawnTransport` exits during a request, the error now includes its exit code or signal and its last stderr lines.
