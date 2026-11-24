---
"@e2e-dev/core": minor
"e2e": minor
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
"@e2e-dev/desktop": patch
---

**Breaking:** Tests get a built-in `request` fixture for HTTP calls. `await request.post('/api/orders', { json: { sku: 'A1' } })` sends a request to a path on the app URL or to an absolute URL, shows in the report as a step, and stops at its `timeout` or the action timeout. It returns a `WebResponse`, the type `browser.waitForResponse` and `route.fetch()` return, which `@e2e-dev/core` and `e2e` now export too. It does not send the browser's cookies. A project fixture already named `request` now extends the built-in one: a worker-scoped one fails at collection, and one declared with its own type through `test.extend<{ request: ... }>({ request: ... })` no longer compiles, so rename it. An engine can no longer contribute a fixture named `request`.
