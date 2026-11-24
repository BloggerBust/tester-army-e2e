---
'@e2e-dev/web': patch
---

`browser.setCookies` checks each cookie against the `Cookie` type before the browser sees it, and refuses one it does not allow with `INVALID_ARGUMENT` naming the field.
