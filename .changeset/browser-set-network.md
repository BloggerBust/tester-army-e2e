---
'@e2e-dev/web': patch
---

`browser.setNetwork('offline')` takes the browser offline for the rest of the test, and `browser.setNetwork('online')` brings it back. It covers every tab and the page's service workers on Chromium, Firefox, and WebKit, so a page its service worker cached still loads, which a route that aborts every request cannot show. A navigation that fails while the browser is offline is `ACTION_FAILED`. Every attempt starts online. [setNetwork](https://e2e.com/docs/reference/web#setnetwork)
