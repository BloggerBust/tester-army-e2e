---
"@e2e-dev/mobile": patch
---

A `screen.swipe({ from, to })` that agent-device refuses before sending anything, because its path leaves the viewport agent-device checks it against, now fails as `ACTION_FAILED` (`NOT_ACTIONABLE`) instead of an infrastructure `ENGINE_FAILURE`. On iOS the open soft keyboard cuts that viewport for a swipe with no `duration`, and then the message says to pass `duration`: a swipe with a duration goes out as a timed pan, which agent-device 0.21.42 sends across the keyboard, so a test can drag the keyboard down to dismiss it interactively.
