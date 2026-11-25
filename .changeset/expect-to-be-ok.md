---
'@e2e-dev/core': patch
'e2e': patch
---

`expect(response).toBeOK()` passes when a response's status is from 200 to 299. It takes what `request`, `browser.waitForResponse`, and `route.fetch()` return, and works with `.not`, `expect.soft`, and `expect.poll`. A failure names the status and the origin and path of the response's URL, never its credentials, query, or fragment.
