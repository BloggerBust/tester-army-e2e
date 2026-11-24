---
"@e2e-dev/web": minor
---

**Breaking:** `browser.route`, `unroute`, and `waitForResponse` now read a string pattern as a Playwright URL glob, so some existing patterns match different requests. `?` is literal instead of one character, `{a,b}` matches either instead of the literal text, `''` matches every URL (so `route('')` intercepts every request), a relative pattern such as `'/api/orders'` resolves against the app URL instead of never matching, and a pattern ending in `**` right after the host, such as `route('http://x.test**')`, matches only URLs that end in `/`. A pattern is normalized like a URL, so `'http://x.test'` matches `http://x.test/`, its scheme and host match in any case, and `/a/../b` reads as `/b`. A `**/` segment may match none, so `'**/a/**/b'` matches `/a/b`, and an unbalanced `{` or `}` is `INVALID_ARGUMENT`. Escape a literal `{`, `}`, or `*` with `\`, or pass a `RegExp`.

`browser.waitForURL` takes the same URL globs, such as `'**/checkout'`, as Playwright's does. A string with no `*`, `{`, `}`, or `\` is still an exact match, but `waitForURL('')` now matches any URL instead of the app URL, and `{`, `}`, and `\` are glob syntax. `expect(browser).toHaveURL` keeps comparing a string exactly, as Playwright's does.
