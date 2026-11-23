---
'@e2e-dev/core': patch
'e2e': patch
---

`screen.tapAt`, `screen.doubleTapAt`, and `screen.swipe({ from, to })` take percentages of the viewport as well as pixels: `screen.tapAt({ x: '50%', y: '50%' })`. Each coordinate is a number of CSS pixels or a string from `'0%'` through `'100%'`, and the two may mix. A percentage reads the screen once for the viewport size. The new `ScreenPoint` and `ScreenCoordinate` types are exported from `e2e` and `@e2e-dev/core`.
