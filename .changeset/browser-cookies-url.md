---
'@e2e-dev/web': patch
---

`browser.cookies(urls)` takes one URL or a list and returns only the cookies a request to them would carry, matched by domain, path, and `Secure`. A relative URL resolves against the base URL. Without an argument it still returns every cookie.
