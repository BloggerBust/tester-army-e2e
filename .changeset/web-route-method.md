---
"@e2e-dev/web": patch
---

`browser.route`, `browser.unroute`, and `browser.waitForResponse` accept a
`{ method, url }` `RouteMatcher` pattern. The method is case-insensitive,
`url` keeps the string or `RegExp` grammar, and a route narrowed to another
method steps aside for the routes registered before it. `unroute` removes the
routes registered with the same pattern, method included.
