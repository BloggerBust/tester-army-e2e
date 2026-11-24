---
'@e2e-dev/core': patch
'e2e': patch
---

`locator.screenshot(label?)` captures the one match and returns the file's path, as `app.screenshot()` does for the screen. It scrolls the match into view, waits until its box and the viewport hold still across the capture, and cuts the screenshot to that box, with the same masking and pixel density. A match larger than the viewport keeps the part inside it. It works on every engine whose screenshot is a PNG of the viewport, which the web, mobile, and desktop engines' are; a custom engine that writes another format gets `UNSUPPORTED_CAPABILITY`.
