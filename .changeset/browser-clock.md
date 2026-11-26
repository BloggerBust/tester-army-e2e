---
'@e2e-dev/web': patch
---

`browser.clock` controls time in the attempt's pages, as Playwright's `page.clock` does: `install({ time })`, `pauseAt`, `resume`, `runFor`, `fastForward`, `setFixedTime`, and `setSystemTime`, with Playwright's arguments, over `Date`, `performance`, timers, and `requestAnimationFrame` in every tab and frame. The clock survives navigation, `app.restart()`, and `app.clearState()`; a CDP recovery after a test used it fails the attempt with `ENGINE_FAILURE`, since the reconnected browser cannot restore it. Only the page's time moves: the test's timeouts and `expect` polling keep real time. A scroll or swipe no longer waits on the page's own animation frame, so it does not hang while a page's clock is paused. An argument Playwright would misread or refuse is `INVALID_ARGUMENT`, and a page timer that throws while the clock runs it is `EVALUATE_FAILED`. [Clock](https://e2e.com/docs/reference/web#clock)
