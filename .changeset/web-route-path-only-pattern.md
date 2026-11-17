---
'@e2e-dev/web': patch
---

`browser.route` rejects path-only string patterns with `INVALID_ARGUMENT`. Use a full-URL glob such as `**/api/orders` or a regular expression.
