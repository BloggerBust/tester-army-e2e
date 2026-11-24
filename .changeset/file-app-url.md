---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/web': patch
'@e2e-dev/mobile': patch
'@e2e-dev/desktop': patch
---

`app.url` takes a `file:` URL: one file on this machine, which a browser the engine launches opens with no server, such as `pathToFileURL('dist/index.html').href`. A host or a directory is `INVALID_APP_URL`. On such a target, `app.open`, `browser.goto`, and the agent's `navigate` take a `file:` URL only for a file in that file's directory or below it, with symbolic links resolved; a file outside it and any directory stay `POLICY_DENIED`, and so does every `file:` URL on a target whose app is not a file. When a link or a script in the page takes the browser outside that directory, no agent step, trace, or failure report is given the screen there, and the agent is sent no screenshot of a file app at all: `agent.assert` with `vision: true` judges from the tree, `vision: 'only'` is `POLICY_DENIED`, and neither `agent.assert` nor a failure keeps a screenshot. A `video` you turn on still records wherever the browser goes. A file has no site, origin, or readiness poll: frames that load another document stay out of observations, `environment` defaults to `'test'`, an `app.command` beside it needs `app.readyUrl`, and a `web()` target with a browser provider, `connect`, `headers`, or `basicAuth` refuses it. An engine opens a file app only when it declares `fileApps: true` on `@e2e-dev/core/engine`, which `web()` does; for any other engine a file `app.url` fails at config load, and `validateApp` is told with `fileApp: true`. `mobile()` and `desktop()` do not declare it.
