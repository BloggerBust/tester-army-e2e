---
'@e2e-dev/core': patch
---

Closing an `@e2e-dev/core` session or host cancels the calls still running on it. An action, a wait, or an `app` or agent call fails with `CANCELLED` and a message that names it, such as `the session closed while app.open "/" was running`, with the stack of the call. `close()` does not fail for them, and Ctrl-C during a running call reports no failed close.
