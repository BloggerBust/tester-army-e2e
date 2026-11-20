# @e2e-dev/core

## 0.25.0

### Minor Changes

- [#1887](https://github.com/e2e-inc/e2e/pull/1887) [`198d25f`](https://github.com/e2e-inc/e2e/commit/198d25f038c5f69c697224ce22e2d73b38c97766) Thanks [@samanyudas](https://github.com/samanyudas)! - **Breaking:** `report-1` reports can now contain the `skip.cause` value `fixme`.
  Update pinned copies of `schema/report-v1.schema.json` from this release and
  handle `fixme` in exhaustive skip-cause checks. The report's `schemaVersion`
  stays `report-1`.
  
  The new `test.fixme` API skips tests at registration or from inside their
  bodies. The report gives the reason as `fixme`, or `fixme: <reason>` when you
  give a non-blank reason.

### Patch Changes

- [#1993](https://github.com/e2e-inc/e2e/pull/1993) [`e939a65`](https://github.com/e2e-inc/e2e/commit/e939a65668b07679b1b2271a66e34a8459eb0fe1) Thanks [@kdy1](https://github.com/kdy1)! - The built-in agent's rules (`BASE_RULES`) now tell the model not to press a save or submit control again when the first press shows no change or is still in progress. The model must first check the screen for a confirmation, an error, a new location, or the changed record. It presses again only when that check shows the first press did not commit, or when the tap only closed the on-screen keyboard, and does not press again when it cannot tell. A step that asks for several commits still presses once for each. It also stays on the step's screen instead of navigating away to confirm a save, so a save that shows no confirmation on that screen can end the step `failed`; name the check in the step ("save the product, then confirm it appears in the product list"). A first press that reached nothing and left no trace, such as a click before the page was ready, is not pressed again either, since it looks the same as a save with no feedback; wait for the page before the save. The loop guard gives the built-in looks more room while a save is still in progress: `observe` and plain `screenshot`, in any order, now warn at six looks with no change and force a verdict at ten, where every other tool keeps three and five; a look whose listing, location, or tabs changed starts the count again, a change in pixels alone does not, and a wait that keeps changing is warned at twelve looks and ended at twenty. Before, the same look repeated stopped at five; such a wait, in a step or in an exploring `agent.assert` with a raised budget, can now spend up to five more model calls on an unchanged screen and up to fifteen more on one that keeps changing. A wait that mixes `observe` and `screenshot` fell under the cycle limits before and now has the same limits of ten and twenty looks. The step budget and deadline still bound the whole step.

- [#2005](https://github.com/e2e-inc/e2e/pull/2005) [`3e7d19d`](https://github.com/e2e-inc/e2e/commit/3e7d19de16ea916ddfd761be3909cc873dd08a73) Thanks [@Toraastrta](https://github.com/Toraastrta)! - The replay cache now also reads a CJK count followed by a copula, such as `42件です`, `42건입니다` or `42건이에요`, as a count, so a growing tally no longer makes the next replay stale.

- [#1919](https://github.com/e2e-inc/e2e/pull/1919) [`e88153b`](https://github.com/e2e-inc/e2e/commit/e88153b2f3b4f6f6b00352dca3960bfe0967975b) Thanks [@WellDunDun](https://github.com/WellDunDun)! - Add `locator.blur()` to remove focus from a web element.

- [#2001](https://github.com/e2e-inc/e2e/pull/2001) [`991b522`](https://github.com/e2e-inc/e2e/commit/991b522830e2c5ede57d4d2f92b2fbb87a9a20ba) Thanks [@okwasniewski](https://github.com/okwasniewski)! - The `waitedMs` of a `LOCATOR_NOT_FOUND` is now counted from the moment the step's timeout started. It was counted from a later clock read, so a wait that ran its whole timeout could report 1 ms less, such as `Waited: 399ms` on a 400 ms timeout.

- [#1972](https://github.com/e2e-inc/e2e/pull/1972) [`25eb2f8`](https://github.com/e2e-inc/e2e/commit/25eb2f8c5a265c083f0e8f41d3109bb7cbf24b2e) Thanks [@satya164](https://github.com/satya164)! - Attach to a test held at `screen.pause()` or `e2e run --step` with
  `open_session {attach: "k3f9"}` in `e2e mcp`. Use the ID from the pause
  header. The attached session has the same tools as a normal session on
  that target. If the run already records the attempt, `start_recording`
  returns an error with the run's video directory. `close_session` detaches
  and leaves the test held. Resume continues the test right away while any
  attached recording saves in the background.

- [#1934](https://github.com/e2e-inc/e2e/pull/1934) [`160cbfe`](https://github.com/e2e-inc/e2e/commit/160cbfe7a06df443d531060fc0e7467cb9db8368) Thanks [@yehomak](https://github.com/yehomak)! - The replay cache now records a value typed into an `autocomplete="one-time-code"` field as a run-time gap, so a code typed one digit per box no longer replays the previous run's code.

- [#1921](https://github.com/e2e-inc/e2e/pull/1921) [`a5d1788`](https://github.com/e2e-inc/e2e/commit/a5d178897a42e3736a5458a27ad3d17dfadbf8c6) Thanks [@imranbarbhuiya](https://github.com/imranbarbhuiya)! - Add `test.setTimeout(timeout)` to change the running test's timeout from its body or a `beforeEach` hook, or a `beforeAll` hook's own timeout.

## 0.24.0

### Minor Changes

- [#1891](https://github.com/e2e-inc/e2e/pull/1891) [`847a09e`](https://github.com/e2e-inc/e2e/commit/847a09e6dbd39e09c8941ddcc903003c61412d81) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - **Breaking:** `test.extend()` fixtures are set up on demand, as in Playwright and Vitest. A test sets up the fixtures its body and its `beforeEach` and `afterEach` hooks name in their first parameter, and the fixtures those fixtures name; a suite hook sets up the worker fixtures it names. A fixture nothing names no longer runs.
  
  To migrate:
  
  - A fixture that exists for its side effect (it seeds data, installs a build, starts a watcher) and that no test names needs `auto: true`: `[fn, { auto: true }]` runs for every test, `[fn, { scope: 'worker', auto: true }]` once per worker.
  - A fixture that relies on another one running first names it: `task: async ({ project, agent }, use) => {}`.
  - A test body, a hook, and a fixture function destructure their first parameter. `async (fixtures) => {}`, `async (_, use) => {}`, a rest property (`{ app, ...rest }`), and a bound function (`fn.bind()`) are now a `COLLECTION_ERROR`; a fixture that needs nothing writes `async ({}, use) => {}`.
  
  A fixture can now name the fixtures declared beside it in the same `test.extend()` call, in any order; a cycle is a `COLLECTION_ERROR` naming it.
  
  These mistakes fail at collection, before any engine starts, with the file and line of the code: a fixture name the target does not have (it was `UNSUPPORTED_CAPABILITY` in the test), and a `beforeAll`, `afterAll`, or worker fixture that names a test fixture (it was `HOOK_FAILED`). A test that does not run on a target (`platforms`, `requires`, `test.skipIf`) is not checked there.
  
  An `afterEach` hook that names a fixture whose setup failed is skipped. On an engine with `isolation: 'worker'`, a suite hook or a worker fixture teardown that names no engine fixture, `app`, or `screen` opens no engine attempt.

### Patch Changes

- [#1917](https://github.com/e2e-inc/e2e/pull/1917) [`6a1cb9a`](https://github.com/e2e-inc/e2e/commit/6a1cb9af45e1b12f6b28070aab7f094dfc8a3c9f) Thanks [@Toraastrta](https://github.com/Toraastrta)! - The replay cache now also reads a CJK count followed by a particle, such as `42件を表示`, `42건이 검색되었습니다` or `42개는 품절`, as a count, so a growing tally no longer makes the next replay stale.

- [#1837](https://github.com/e2e-inc/e2e/pull/1837) [`336c428`](https://github.com/e2e-inc/e2e/commit/336c42819c07e63f4928483b907224c763ce414f) Thanks [@Toraastrta](https://github.com/Toraastrta)! - The replay cache now reads counts written with a CJK counter (`42件`, `42个`, `42개`) the way it reads `42 items`, so a growing tally no longer makes the next replay stale.

- [#1955](https://github.com/e2e-inc/e2e/pull/1955) [`f3cd032`](https://github.com/e2e-inc/e2e/commit/f3cd0321048ee73aae6464599473cb62b130341a) Thanks [@JaynouOliver](https://github.com/JaynouOliver)! - A recorded step that showed a clock time with am or pm written against it (`Last saved 5:42pm`) now replays a minute later. The time was read as fixed text and kept as an end anchor, while `5:42 PM` and `17:42` were already skipped.

- [#1965](https://github.com/e2e-inc/e2e/pull/1965) [`60d29cf`](https://github.com/e2e-inc/e2e/commit/60d29cfe4c9d88b00659e0d0e00b8973d61e7391) Thanks [@szymonrybczak](https://github.com/szymonrybczak)! - List the maintainers' `@e2e.com` addresses in `contributors`.

- [#1880](https://github.com/e2e-inc/e2e/pull/1880) [`51d304e`](https://github.com/e2e-inc/e2e/commit/51d304e736098913ab3c7f94da7be0264ee6cfa2) Thanks [@okwasniewski](https://github.com/okwasniewski)! - Closing an `@e2e-dev/core` session or host cancels the calls still running on it. An action, a wait, or an `app` or agent call fails with `CANCELLED` and a message that names it, such as `the session closed while app.open "/" was running`, with the stack of the call. `close()` does not fail for them, and Ctrl-C during a running call reports no failed close.

- [#1737](https://github.com/e2e-inc/e2e/pull/1737) [`0a5ee16`](https://github.com/e2e-inc/e2e/commit/0a5ee16387cf213df547a8422b7d690675744986) Thanks [@kdy1](https://github.com/kdy1)! - New package `@e2e-dev/core`: the engine contract, locators, agent, replay cache, and engine sessions that `e2e` is built on. `e2e` depends on it at the same version, and `e2e/engine` and `e2e/agent` re-export it unchanged. `@e2e-dev/web` and `@e2e-dev/mobile` peer on `@e2e-dev/core` beside `e2e`, and import the contract from `@e2e-dev/core/engine`, which a third-party engine can now import too. npm, pnpm and Bun install the new peer themselves. A Yarn project lists `@e2e-dev/core` beside the engine; `e2e init` and `e2e upgrade` add it.

- [#1734](https://github.com/e2e-inc/e2e/pull/1734) [`dbe3dc5`](https://github.com/e2e-inc/e2e/commit/dbe3dc54a9123b10e535441f785de2e81a202798) Thanks [@kdy1](https://github.com/kdy1)! - New package `@e2e-dev/core`: drive a browser or a native app from plain code, with no test runner, config file, or report. `launch(web())` prepares an engine and returns a host; `host.newSession()` opens an isolated session holding `screen`, `app`, `platform`, and the engine's fixture. `session.saveState()` captures state in memory, and `SessionState.export({ key })` returns it only AES-256-GCM encrypted, as `session-state-1` bytes. Secrets go to `launch({ secrets })` and fill through `host.secret(name)`. `createAgent(session, { model, cache })` from `@e2e-dev/core/agent` adds the agent: with `cache`, every `act` names its recording with `cacheKey`.
  
  `@e2e-dev/web` and `@e2e-dev/mobile` need `e2e` only for the `test` their main entry exports, so their `e2e` peer is optional. Without `e2e`, the main entry still loads and its engine factory works; `test`, `describe`, and the hooks throw `RUNNER_NOT_INSTALLED` when called. Its types still name `e2e`, so a TypeScript program without it imports from the `/engine` entry or sets `skipLibCheck`. `@e2e-dev/core/agent` also exports what `e2e/agent` does, `defineTool` among it.
  
  Device targets take `app.linkBase`: `app.open('/orders/42')` then opens the path as a link in the pinned app, through the new optional engine hook `session.openLink` (protocol method `session/openLink`). `@e2e-dev/mobile` implements it.
  
  `@e2e-dev/web/engine` and `@e2e-dev/mobile/engine` export the engine factories and their types without `test`, so a program that only drives an engine never loads the test runner. `defineEngine<Fixtures>()` and `EngineHandle<Fixtures>` now carry the fixtures an engine contributes as a type, and `defineEngine` requires a factory for each one `Fixtures` names: `web()` is an `EngineHandle<WebFixtures>`, `mobile()` an `EngineHandle<MobileFixtures>`. `defineEngine` refuses a fixture named `close`, `saveState`, or `setDefaultTimeout`, the methods of a session. `@e2e-dev/core/engine` (and `e2e/engine`) exports `isRefusedLinkScheme`, the scheme list app links are refused by, which `@e2e-dev/mobile` now uses for `device.openLink`.

- [#1891](https://github.com/e2e-inc/e2e/pull/1891) [`847a09e`](https://github.com/e2e-inc/e2e/commit/847a09e6dbd39e09c8941ddcc903003c61412d81) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - `test.extend()` can extend a fixture the `test` already has, a built-in one included: `base.extend({ device: async ({ device }, use) => { await device.setPermission('camera', 'deny'); await use(device); } })`. Inside the function the fixture's own name is the fixture it extends (the built-in, or an earlier fixture of that name), and tests, hooks, and other fixtures that name it get the value passed to `use`. It keeps the type, the scope, and the `auto` of the fixture it extends on the target, so a `device` override on a mobile target runs once per worker and reaches `beforeAll`, and an override of an `auto` fixture is set up for every test; a `scope` or an `auto` that differs is a `COLLECTION_ERROR` naming both. On a target without that built-in, nothing fails until code that runs there names it.
  
  A fixture named like a core fixture (`agent`, `app`, `screen`, `platform`, `session`), like one the target's engine contributes, or like one an earlier `extend` defined was refused before (`COLLECTION_ERROR`, or `TEST_SETUP_FAILED` in the test).

- [#1823](https://github.com/e2e-inc/e2e/pull/1823) [`1b7c3a9`](https://github.com/e2e-inc/e2e/commit/1b7c3a99d6e7dad74456da1476d522159ccf9b6d) Thanks [@kdy1](https://github.com/kdy1)! - Every `agent.act` step on an engine that can fill secrets now gets the same tool set, so a step with a `Secret` param reads the provider prompt cache like the other steps. `type_secret` is always offered there, and the step's opening message lists the secrets it declares. A judgment prompt now puts the test's title after its fixed request text, which lengthens the prefix a provider can cache.

- [#1860](https://github.com/e2e-inc/e2e/pull/1860) [`aadf955`](https://github.com/e2e-inc/e2e/commit/aadf95506d05d2888db75792182b634912acbcef) Thanks [@kdy1](https://github.com/kdy1)! - The JUnit report keeps the `\r\n` line breaks of failure messages and skip reasons instead of writing U+FFFD: `junit.xml` reads `&[#13](https://github.com/e2e-inc/e2e/issues/13);&[#10](https://github.com/e2e-inc/e2e/issues/10);`, and `report.json` and reporter events keep the `\r`. A `\r` with no `\n` after it still becomes U+FFFD, and the terminal output is unchanged.

- [#1935](https://github.com/e2e-inc/e2e/pull/1935) [`9d240ac`](https://github.com/e2e-inc/e2e/commit/9d240ac954f65804fece214bfbf112966364d644) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A secret passed only to `launch()` inside an `e2e run` test is now redacted from the test's report, trace, downloads, and model input until the test ends, and the host's sessions redact the config's secrets. Every session in a process redacts the secrets of the hosts and sessions open beside it, on a browser and on a device alike, without carrying them into a saved state. An error a session throws no longer carries a secret in its `details`.

- [#1935](https://github.com/e2e-inc/e2e/pull/1935) [`9d240ac`](https://github.com/e2e-inc/e2e/commit/9d240ac954f65804fece214bfbf112966364d644) Thanks [@okwasniewski](https://github.com/okwasniewski)! - A session a test opens with `launch()` is now in the test's report: its steps under `launch-1`, `launch-2`, in the order they ran, its model usage counted with the test's, and its video kept beside the test's when the test records one. Steps and video artifacts carry an `actor`, and so does `progress.identity` for reporters. The test owns what it opened: a host or session it leaves open is closed when the test ends, a step it leaves running fails the test with `STEP_NOT_AWAITED`, and a timeout cuts a session's step as it cuts the test's own. The trace page, the HTML report, and the Markdown and JUnit failure text name the session, and the HTML report plays each step in its own session's video. While such a session records for the test, `app.startRecording()` on it fails with `UNSUPPORTED_CAPABILITY`, as it does on the test's own session.

- [#1865](https://github.com/e2e-inc/e2e/pull/1865) [`fabb0c0`](https://github.com/e2e-inc/e2e/commit/fabb0c07fb9891853576ad8975fa488858898c16) Thanks [@imranbarbhuiya](https://github.com/imranbarbhuiya)! - `expect(locator, message)`, `expect(screen, message)`, and their `expect.soft` forms take an optional message, as value expectations already do. It opens every assertion failure, `.not` and `toHaveScreenshot` included, and a locator's `LOCATOR_AMBIGUOUS` error: `the cart is empty: expect.toBeVisible failed`.

- [#1835](https://github.com/e2e-inc/e2e/pull/1835) [`95c574a`](https://github.com/e2e-inc/e2e/commit/95c574adec0d6844bda5fa503d1fe1cd64041ac5) Thanks [@mvanhorn](https://github.com/mvanhorn)! - A built-in agent tool that takes no input drops keys the model sends and runs. `observe`, `back`, `dismiss_keyboard`, and `screenshot` (when it has no `path`) used to reject a padded call such as `screenshot({"description": "check the home screen"})`, and some models resent that refusal until the step budget ended. A tool that declares fields still rejects a key it does not declare.

- [#1834](https://github.com/e2e-inc/e2e/pull/1834) [`0cd14a0`](https://github.com/e2e-inc/e2e/commit/0cd14a0dfa9b87e52cce54348ab32f7dc0c44fc6) Thanks [@kdy1](https://github.com/kdy1)! - Actions, `waitFor`, and assertions that miss on their first read now read again at 20 ms and 50 ms, then every 100 ms from the start of the wait, as before. A node or state that arrives in the first 100 ms is seen up to 80 ms sooner, and one that arrives later is seen no later than before.

- [#1904](https://github.com/e2e-inc/e2e/pull/1904) [`4893d1d`](https://github.com/e2e-inc/e2e/commit/4893d1dd7574a6661363bc43e33b335f40be667c) Thanks [@satya164](https://github.com/satya164)! - Add `screen.pause()` to pause a test at a line, with the app open, until you
  resume it: press Enter in the terminal, or run `e2e run --step next` from
  another shell in the same directory. With `CI` set, the test fails with
  `PAUSE_UNAVAILABLE`.

- [#1863](https://github.com/e2e-inc/e2e/pull/1863) [`d960d2c`](https://github.com/e2e-inc/e2e/commit/d960d2c4484d74aaec106811578d83021cf5b723) Thanks [@samanyudas](https://github.com/samanyudas)! - When an engine server started with `spawnTransport` exits during a request, the error now includes its exit code or signal and its last stderr lines.

- [#1891](https://github.com/e2e-inc/e2e/pull/1891) [`847a09e`](https://github.com/e2e-inc/e2e/commit/847a09e6dbd39e09c8941ddcc903003c61412d81) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - `STEP_NOT_AWAITED` names the code that left the step running. A step call without `await` in a `beforeEach` hook, a fixture's setup, or a `beforeAll` or `afterAll` hook used to read `the test body returned before ...`. It now reads `the beforeEach hook returned before app.open "/" finished`, `the fixture "account" setup returned before ...`, or `the beforeAll hook returned before ...`. A session opened with `@e2e-dev/core` says `the hosted session`.

- [#1810](https://github.com/e2e-inc/e2e/pull/1810) [`3761bb9`](https://github.com/e2e-inc/e2e/commit/3761bb9b9497a1416512abd598707289a1b2817e) Thanks [@samanyudas](https://github.com/samanyudas)! - `--strict-cache` no longer fails with `REPLAY_STALE` a never-recorded step whose test id, target, or agent name is over 300 characters and starts like a recorded one.

- [#1882](https://github.com/e2e-inc/e2e/pull/1882) [`a213247`](https://github.com/e2e-inc/e2e/commit/a213247170b3d149b6297c5f3eddfd7b5cb782f6) Thanks [@bardrop](https://github.com/bardrop)! - Add `test.each(rows)` and `test.for(rows)`, which register one test per row with a title formatted from the row (`$user`, `%s`, `%i`, `%#`). `test.each` spreads an array row into the body's arguments and `test.for` passes it whole. The fixtures come last, and the body names the ones it uses by destructuring that parameter: `async ({ user }, { app }) => {}`.

- [#1870](https://github.com/e2e-inc/e2e/pull/1870) [`1d0271b`](https://github.com/e2e-inc/e2e/commit/1d0271b3066681a0aeca283060d33562616ece8a) Thanks [@samanyudas](https://github.com/samanyudas)! - Add `test.skipIf(condition)` and `test.runIf(condition)`, which skip or run a test based on a condition, without wrapping `test()` in an `if`.

- [#1819](https://github.com/e2e-inc/e2e/pull/1819) [`3422abf`](https://github.com/e2e-inc/e2e/commit/3422abfb6a58a9f1f58e8532429e987e83053860) Thanks [@kdy1](https://github.com/kdy1)! - `agent.waitFor` judges a screen change as soon as it sees it instead of first waiting out `interval` after the previous judgment, so a condition that comes true mid-wait resolves within about 500 ms plus one model call rather than up to 3 s later. While the screen keeps changing (a progress counter, a clock), it still judges at most once per `interval`.

- [#1891](https://github.com/e2e-inc/e2e/pull/1891) [`847a09e`](https://github.com/e2e-inc/e2e/commit/847a09e6dbd39e09c8941ddcc903003c61412d81) Thanks [@KrzysztofMoch](https://github.com/KrzysztofMoch)! - `test.extend()` takes worker fixtures: `[fn, { scope: 'worker' }]`, typed with the second type argument (`base.extend<{}, { database: Database }>(...)`). A worker fixture is set up once per worker and target, the first time a test or suite hook registered through its `test` runs, and torn down when the worker ends. It sees worker fixtures only.
  
  `beforeAll` and `afterAll` now receive worker fixtures: `platform` and the worker fixtures of the `test` they were registered through. Reading a test fixture there fails the hook with `HOOK_FAILED` naming the fixture. `SuiteFixtures` and `SuiteHookFn` are deprecated aliases of `WorkerFixtures` and `TestHookFn<WorkerFixtures>`.
  
  `defineEngine` takes `isolation: 'worker'`, which the engine protocol's manifest carries too. It makes the engine's fixtures, `app`, and `screen` worker fixtures. `@e2e-dev/mobile` declares it, so a mobile `beforeAll` can set a permission or open the app.
