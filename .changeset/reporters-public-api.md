---
'e2e': patch
'@e2e-dev/html-reporter': patch
---

The built-in reporters are built on the public `Reporter` contract. Ids such as `'list'` and `'junit'` work as before; to pass options, call the factory from `e2e/reporters` instead: `list()`, `dot()`, `json()`, `junit({ outputFile })`, and `markdown({ outputFile })`. A reporter of your own can now do everything the built-ins do: take what user code prints (`onOutput`), show the `--step` prompt (`onStepPrompt`), print every reporter's summary rows (`onSummary`), and return files the runner writes atomically, even after a second Ctrl-C (`reportFiles`). `printsTo` names the terminal stream a reporter prints to, one reporter per stream; beside `json`, `list` and `dot` print to stderr unless given a `stream`, so `--reporter list,json` now works like `dot,json`. `--reporter` keeps the options of a built-in the config configured. `@e2e-dev/html-reporter` writes `report.html` through `reportFiles`.
