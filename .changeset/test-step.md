---
'@e2e-dev/core': patch
'e2e': patch
'@e2e-dev/html-reporter': patch
---

`test.step(title, fn)` runs a function as one named step and returns what it returns. The trace page, the HTML report, and an MCP test outcome show the title with the calls made inside it nested under it, and steps nest. The list reporter shows the steps of a running test, and keeps a `test.step` in its output when it failed or an agent step ran inside it. A failure summary names the `test.step` the failed call was in. In `report.json` it is a step of kind `step` with the api `test.step`, each step inside it carries its index as `parent`, and step progress carries `identity.parentStepId`; the CTRF report has `parent` in a step's `extra`. [test.step](https://e2e.com/docs/reference/test#test-step)
