---
'@e2e-dev/web': patch
---

`browser.route`, `browser.unroute`, and `browser.waitForResponse` now reject common path-only and schemeless host patterns with `INVALID_ARGUMENT`. Use a full URL glob such as `**/api/orders` or a regular expression instead.