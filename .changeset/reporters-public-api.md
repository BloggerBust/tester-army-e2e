---
'e2e': minor
'@e2e-dev/core': minor
'@e2e-dev/html-reporter': patch
---

**Breaking:** without `list`, `dot`, or another interactive reporter, what your code prints goes to stderr where it went to stdout before. So does what the config prints while it loads. Stdout now holds only what a reporter prints there, and beside `json` only the JSON report.

**Deprecated:** the `plan` run event. Read `collected`, which follows it with the same `total` and `files`. `plan` is removed no earlier than April 1, 2027.

The built-in reporters are built on the public `Reporter` contract, so a reporter of your own can do everything they do. Ids such as `'list'` and `'junit'` work as before; to pass options, call the factory from `e2e/reporters`: `list()`, `dot()`, `json()`, `junit({ outputFile })`, and `markdown({ outputFile })`. `--reporter` keeps the options of a built-in the config configured, and `--reporter list,json` works like `dot,json`: `list` prints to stderr beside `json`.

A reporter has one live hook, `onEvent`, and three for the finished run: `reportFiles` returns files the runner writes atomically, `onRunFinished` uploads or notifies, and `onSummary(rows, run)` prints, redacted, such as every reporter's summary rows or a document on stdout. `interactive: true` marks the one reporter that shows the run in the terminal, as `list` and `dot` do; the runner then prints nothing itself.

New in the event stream:

- `collected` lists every test of the run in `tests` before the first one starts, with `repeatEach`.
- A step's `start` progress has `source`, the test file line that called it.
- `paused` and `resumed` say when a test waits at a `--step` prompt or `screen.pause()`.
- `output` events include what the runner process prints, with no `target`.

Every reporter gets the same event object, with its own fields frozen.

`--step` works with the json reporter in a terminal. After a second Ctrl-C, `reportFiles` has 5 seconds left.

`@e2e-dev/html-reporter` writes `report.html` through `reportFiles` and needs `e2e` 0.24.1 or later.
