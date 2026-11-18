---
'@e2e-dev/web': patch
---

`browser.route`, `browser.unroute`, and `browser.waitForResponse` now reject common path-only and schemeless host patterns with `INVALID_ARGUMENT`. Use `**/api/orders` to match the path on any origin, or a full URL such as `http://localhost:3000/api/orders` to target one origin. Regular expressions are also supported.
