---
'@e2e-dev/web': patch
---

`browser.name` and `browser.version` tell a test which browser it runs in. `name` is `'chromium'`, `'firefox'`, or `'webkit'`, and always `'chromium'` for a browser attached over CDP, and `version` is the version the running browser reports, for a hosted or attached browser too. Skip a test on one browser with `test.skip(browser.name === 'firefox', 'reason')` in its body. [name, version](https://e2e.com/docs/reference/web#name-version)
