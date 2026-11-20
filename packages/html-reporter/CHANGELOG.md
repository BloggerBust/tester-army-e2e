# @e2e-dev/html-reporter

## 0.0.3

### Patch Changes

- [#1936](https://github.com/e2e-inc/e2e/pull/1936) [`eddf577`](https://github.com/e2e-inc/e2e/commit/eddf5775264134b61ce5ac986370dce2bf75844b) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - The built-in reporters are built on the public `Reporter` contract. Ids such as `'list'` and `'junit'` work as before; to pass options, call the factory from `e2e/reporters` instead: `list()`, `dot()`, `json()`, `junit({ outputFile })`, and `markdown({ outputFile })`. A reporter of your own can now do everything the built-ins do: take what user code prints (`onOutput`), show the `--step` prompt (`onStepPrompt`), print every reporter's summary rows (`onSummary`), and return files the runner writes atomically, even after a second Ctrl-C (`reportFiles`). `printsTo` names the terminal stream a reporter prints to, one reporter per stream; beside `json`, `list` and `dot` print to stderr unless given a `stream`, so `--reporter list,json` now works like `dot,json`. `--reporter` keeps the options of a built-in the config configured. `@e2e-dev/html-reporter` writes `report.html` through `reportFiles`.

## 0.0.2

### Patch Changes

- [#1965](https://github.com/e2e-inc/e2e/pull/1965) [`60d29cf`](https://github.com/e2e-inc/e2e/commit/60d29cfe4c9d88b00659e0d0e00b8973d61e7391) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - List the maintainers' `@e2e.com` addresses in `contributors`.

- [#1829](https://github.com/e2e-inc/e2e/pull/1829) [`3fac999`](https://github.com/e2e-inc/e2e/commit/3fac999c460bc2dfc1268aba9316e3f67ca9ad4f) Thanks [@Wali05](https://github.com/Wali05)! - Durations just under a unit boundary now read `1.0s`, `1m 0s`, or `2m 0s` instead of `1000ms`, `60.0s`, or `1m 60s`.

- [#1915](https://github.com/e2e-inc/e2e/pull/1915) [`243eaa4`](https://github.com/e2e-inc/e2e/commit/243eaa40ec5e60cd46bbe9422026d386cd3325e0) Thanks [@Asheesh7298](https://github.com/Asheesh7298)! - `htmlReporter()` no longer overwrites `report.html` when a run stops before its tests.

- [#1793](https://github.com/e2e-inc/e2e/pull/1793) [`f5cda16`](https://github.com/e2e-inc/e2e/commit/f5cda163137b298bfef82bd25281d7e872d47f46) Thanks [@DeryFerd](https://github.com/DeryFerd)! - Filter a run's results by target in the HTML report: on a multi-target run target tabs sit above the status tabs, and the counts, the test tree, and the header follow the selected target.

- [#1935](https://github.com/e2e-inc/e2e/pull/1935) [`9d240ac`](https://github.com/e2e-inc/e2e/commit/9d240ac954f65804fece214bfbf112966364d644) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A session a test opens with `launch()` is now in the test's report: its steps under `launch-1`, `launch-2`, in the order they ran, its model usage counted with the test's, and its video kept beside the test's when the test records one. Steps and video artifacts carry an `actor`, and so does `progress.identity` for reporters. The test owns what it opened: a host or session it leaves open is closed when the test ends, a step it leaves running fails the test with `STEP_NOT_AWAITED`, and a timeout cuts a session's step as it cuts the test's own. The trace page, the HTML report, and the Markdown and JUnit failure text name the session, and the HTML report plays each step in its own session's video. While such a session records for the test, `app.startRecording()` on it fails with `UNSUPPORTED_CAPABILITY`, as it does on the test's own session.

- [#1851](https://github.com/e2e-inc/e2e/pull/1851) [`9034956`](https://github.com/e2e-inc/e2e/commit/9034956b204e57be2ef982148c02d1d573ec495d) Thanks [@Wali05](https://github.com/Wali05)! - Token counts just under a million now read `1.0M` instead of `1000.0k`, and the HTML report shows millions as `2.5M` instead of `2500.0k`.

## 0.0.1

### Patch Changes

- [#1730](https://github.com/e2e-inc/e2e/pull/1730) [`7e309c1`](https://github.com/e2e-inc/e2e/commit/7e309c151e4d82f7c1e14c139ba77ed0c7993ee9) Thanks [@karolkulesza](https://github.com/karolkulesza)! - The setup guide's link to the `command` reference no longer returns 404. The e2b and HTML reporter READMEs link to e2e.com instead of e2e.tester.army.

- [#1672](https://github.com/e2e-inc/e2e/pull/1672) [`3735887`](https://github.com/e2e-inc/e2e/commit/373588756937562aa89c7dd7f7995ac6b16db972) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Move GitHub repository metadata and CLI links to e2e-inc/e2e after the organization rename. Register the MCP server as io.github.e2e-inc/e2e.

- [#1642](https://github.com/e2e-inc/e2e/pull/1642) [`a133807`](https://github.com/e2e-inc/e2e/commit/a13380728fc0822f1da477fdec0da10632c84cc0) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - New package: `htmlReporter()` writes the run as one HTML page, `.e2e/report.html`, that opens from disk with no server. It lists the tests by file with status tabs and search, and shows each test's attempts, error, steps, screenshots, and video, with each step linked to its moment in the video. Agent steps show their explanation, the actions they took, the model, tokens and cost, and whether the step replayed from the cache. A failed assertion that reports expected and received values shows them with the difference marked. When the test file is in the project, the failure shows the code around the failing call, and each step opens to its code. **copy prompt** on a failed test copies its failure, steps, and file paths for a coding agent. The page has a light and a dark theme, following the system's by default. `media: 'embed'` puts screenshots and videos in the page so the one file is the whole report, and `media: 'none'` leaves them out.
