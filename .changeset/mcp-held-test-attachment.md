---
'e2e': patch
'@e2e-dev/core': patch
---

Attach to a test held at `screen.pause()` or `e2e run --step` with
`open_session {attach: "k3f9"}` in `e2e mcp`. Use the ID from the pause
header. The attached session has the same tools as a normal session on
that target. If the run already records the attempt, `start_recording`
returns an error with the run's video directory. `close_session` detaches
and leaves the test held. Resume continues the test right away while any
attached recording saves in the background.
