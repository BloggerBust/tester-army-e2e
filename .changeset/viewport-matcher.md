---
"e2e": patch
"@e2e-dev/core": patch
"@e2e-dev/web": patch
"@e2e-dev/mobile": patch
---

Add `expect(locator).toBeInViewport({ ratio })`, which waits for part of the
match, or that share of its box, to be inside the viewport without scrolling.
No match counts as outside, so `.not` accepts zero matches. The web engine
measures with the page's `IntersectionObserver`, matching Playwright, so
scrolling and `overflow` ancestors and frames clip the box. The mobile engine
reports only whether the node is on screen, because a device reports bounds
already clipped, so `ratio > 0` there fails with `UNSUPPORTED_CAPABILITY`
once the node is on screen.
Engines implement the optional `viewportIntersection` method for the new
`viewport-intersection` capability.
