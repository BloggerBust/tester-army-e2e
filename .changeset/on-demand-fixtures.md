---
'e2e': minor
'@e2e-dev/core': minor
---

**Breaking:** `test.extend()` fixtures are set up on demand, as in Playwright and Vitest. A test sets up the fixtures its body and its `beforeEach` and `afterEach` hooks name in their first parameter, and the fixtures those fixtures name; a suite hook sets up the worker fixtures it names. A fixture nothing names no longer runs.

To migrate:

- A fixture that exists for its side effect (it seeds data, installs a build, starts a watcher) and that no test names needs `auto: true`: `[fn, { auto: true }]` runs for every test, `[fn, { scope: 'worker', auto: true }]` once per worker.
- A fixture that relies on another one running first names it: `task: async ({ project, agent }, use) => {}`.
- A test body, a hook, and a fixture function destructure their first parameter. `async (fixtures) => {}`, `async (_, use) => {}`, a rest property (`{ app, ...rest }`), and a bound function (`fn.bind()`) are now a `COLLECTION_ERROR`; a fixture that needs nothing writes `async ({}, use) => {}`.

A fixture can now name the fixtures declared beside it in the same `test.extend()` call, in any order; a cycle is a `COLLECTION_ERROR` naming it.

These mistakes fail at collection, before any engine starts, with the file and line of the code: a fixture name the target does not have (it was `UNSUPPORTED_CAPABILITY` in the test), and a `beforeAll`, `afterAll`, or worker fixture that names a test fixture (it was `HOOK_FAILED`). A test that does not run on a target (`platforms`, `requires`, `test.skipIf`) is not checked there.

An `afterEach` hook that names a fixture whose setup failed is skipped. On an engine with `isolation: 'worker'`, a suite hook or a worker fixture teardown that names no engine fixture, `app`, or `screen` opens no engine attempt.
