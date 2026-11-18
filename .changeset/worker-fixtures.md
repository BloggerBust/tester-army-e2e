---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
---

`test.extend()` takes worker fixtures: `[fn, { scope: 'worker' }]`, typed with the second type argument (`base.extend<{}, { database: Database }>(...)`). A worker fixture is set up once per worker and target, the first time a test or suite hook registered through its `test` runs, and torn down when the worker ends. It sees worker fixtures only.

`beforeAll` and `afterAll` now receive worker fixtures: `platform` and the worker fixtures of the `test` they were registered through. Reading a test fixture there fails the hook with `HOOK_FAILED` naming the fixture. `SuiteFixtures` and `SuiteHookFn` are deprecated aliases of `WorkerFixtures` and `TestHookFn<WorkerFixtures>`.

`defineEngine` takes `isolation: 'worker'`, which the engine protocol's manifest carries too. It makes the engine's fixtures, `app`, and `screen` worker fixtures. `@e2e-dev/mobile` declares it, so a mobile `beforeAll` can set a permission or open the app.
