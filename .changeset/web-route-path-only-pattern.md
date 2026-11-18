---
'@e2e-dev/web': patch
---

`browser.route`, `browser.unroute`, and `browser.waitForResponse` now reject common patterns that cannot match an HTTP or HTTPS URL, returning `INVALID_ARGUMENT`. Use `**/api/orders` to match the path on any origin or `http://localhost:3000/api/orders` to match a specific URL. Regular expressions are also supported.