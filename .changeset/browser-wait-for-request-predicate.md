---
'@e2e-dev/web': patch
---

Add `browser.waitForRequest` and predicate support for `browser.waitForResponse` and `browser.waitForRequest`. Both accept a URL glob, a `RegExp`, `{ method, url }`, or a sync or async predicate, and refuse options other than `timeout`. `waitForResponse` now returns a `PageResponse`, extending `WebResponse` with `request: WebRequest`, and `waitForRequest` returns `WebRequest`, the same type as `route.request`.
