# Writing tests

## Contents

- A complete file
- Structure: one describe, arrange-act-assert, one behavior
- Registration
- Fixtures
- Locators
- expect
- Sign-in sessions
- Start near the screen under test
- The browser fixture (browser only)
- Habits

Always read "A complete file" and "Structure" first. Load later API sections
(`Registration`, `Fixtures`, `Locators`, `expect`, `Sign-in sessions`,
`The browser fixture`) only as needed, and check
`node_modules/e2e/docs/reference/` for full option tables.

## A complete file

```ts
// tests/todos.e2e.ts
import { test, expect } from 'e2e';

test.describe('todos', { tags: ['todos'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/todos');
  });

  const labels = { list: 'Todos', remaining: 'Remaining' };
  const title = 'Write the release notes';
  const other = 'Book the venue';
  const addTodo = 'Add a todo named {title}';

  test('adds a todo to the list', async ({ agent, screen }) => {
    await agent.act(addTodo, { params: { title } });

    await expect(screen.getByRole('checkbox', title)).not.toBeChecked();
    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(1);
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('marks a todo as done', async ({ agent, screen }) => {
    const todo = screen.getByRole('checkbox', title);
    await agent.act(addTodo, { params: { title: other } });
    await agent.act(addTodo, { params: { title } });
    await todo.waitFor();

    // the second todo shown: this list adds new todos at the end
    await agent.act('Mark {title} as done', { params: { title } });

    await expect(todo).toBeChecked();
    await expect(screen.getByRole('checkbox', other)).not.toBeChecked();
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('ignores an empty submission', async ({ screen }) => {
    // An exact interaction: the empty submit is the point of the test.
    await screen.getByRole('button', 'Add').tap();

    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(0);
  });
});
```

The agent drives the flow. A passing `agent.assert` or locator matcher
checks the outcome and confirms the preceding actions for replay. `screen`
actions are for low-level mechanics under test (like `ignores an empty
submission` above), `test.setup` sign-in, or configs with no model; a goal
takes its values in `params`. Files match the config
`tests` glob, default `tests/**/*.e2e.ts`. In a browser every test starts
from a fresh context with no page open, so it calls `app.open()` first; on a
device a test that skips `app.open()` starts where the previous test left
the app.

## Structure: one describe, arrange-act-assert, one behavior

Write every test so a failing title names what broke.

- **One top-level `describe` per feature.** Put every test for the feature and
  its shared hooks inside one `describe('todos')` per file. Nest `describe`
  only to share a hook or option (`session`, `agentContext`, `tags`). Exception:
  `test.setup` must be top-level, outside any `describe`.
- **Arrange, act, assert in order.** Inside `describe`, put `beforeAll`, then
  `beforeEach`, then shared constants, then tests. Inside a test, keep act and
  assert separated by a blank line:
  - **Arrange:** reach the starting state via `session`, fixtures, hooks, or
    one-off setup. End UI setup with a wait (`locator.waitFor()`,
    `agent.waitFor()`) so setup fails there and confirms setup `agent.act` steps
    for the replay cache.
  - **Act:** pursue the test's one goal. Start with one `agent.act` call
    spelling out required fields, choices, buttons, and order; split when a
    later step needs a known screen state, risks `maxSteps`/`maxModelCalls`
    budgets, or needs a middle step boundary (explain why and wait for the
    intermediate screen state). Before leaving a screen or calling
    `agent.assert`, wait for the required state.
  - **Assert:**
    - Put every `expect`, `expect.poll`, and `agent.assert` here, with nothing
      after them (exception: `session.save()` in a setup test).
    - Never assert mid-way: wait on a narrowed locator instead, such as
      `balance.filter({ hasText: /^\$10\.00$/ }).waitFor()` (use anchored
      `hasText` on leaf status/value nodes since it checks subtree text on web
      and individual nodes on core/mobile; use
      `filter({ has: screen.getByText(name) })` for exact row matching),
      `screen.getByRole('switch', 'Lock card', { checked: true }).waitFor()`,
      or `heading.waitFor({ state: 'hidden' })` after an earlier positive wait
      (`hidden` passes immediately on zero matches, including typos, and still
      confirms prior `agent.act` steps).
    - Never move a pre-reload or pre-navigation assertion past a reload or
      navigation (split the earlier phase into its own test instead). Never
      stash one-shot reads (`isVisible()`, `isEnabled()`, `count()`,
      `inputValue()`, `textContent()`, `getAttribute()`, `browser.evaluate()`)
      mid-flow into local variables just to assert them at the end: leave a
      precondition as `.waitFor()` alone with no extra `expect`, split earlier
      phases so retrying matchers run on the live screen, or use
      `expect.poll(...)` for computed CSS/DOM checks. When a computed arrange
      precondition is missing, `throw` directly instead of inventing a
      fallback value.
    - On zero-match timeout, waits report `LOCATOR_NOT_FOUND` and checks
      `ASSERTION_FAILED`; two matches throw `LOCATOR_AMBIGUOUS` on either.
- **One behavior and one goal per test.** Title names one outcome
  (`'marks a todo as done'`, not `'adds and completes a todo'`). Multiple
  assertions checking that one outcome are fine; a second behavior is a second
  test that arranges its own starting state. Never undo an action before
  asserting its effect (returning to the starting value hides a no-op), and
  never leave a screen before checking what the test promised on it.
- **Prove the change on the changed record.** Ask what wrong behavior would
  still pass (no-op, deleted row, wrong row, unsaved reload). Pick an end value
  the start cannot show, write expected values as literals, and scope checks to
  the record's row/card/dialog (never `.first()`). When persistence is part of
  the promise, wait for confirmation, reopen afresh, and compare against inputs
  (plus a fresh API/storage read by id when available). Check only promised
  behavior; the title claims only what assert checks.
- **Act on the second item shown, never the first.** When a test removes,
  edits, renames, completes, or toggles one item of a list (a row, a line,
  a card), its arrange block adds two items, and its act picks the second
  item the list shows. In a list that shows the newest item first, that is
  the item added first. Its assert block then checks that the first item is
  still there, unchanged. An app that always changes the first row passes a
  test that acts on the first row.

  ```ts
  // Bad: deletes the first todo, so an app that always deletes row 1 passes.
  await agent.act(addTodo, { params: { title: other } });
  await agent.act(addTodo, { params: { title } });
  await agent.act('Delete {title}', { params: { title: other } });

  // Good: deletes the second todo (this list adds new todos at the end),
  // then checks the first one is still there and unchanged.
  const todo = screen.getByRole('checkbox', title);
  const otherTodo = screen.getByRole('checkbox', other);
  await agent.act(addTodo, { params: { title: other } });
  await agent.act(addTodo, { params: { title } });
  await todo.waitFor();

  await agent.act('Delete {title}', { params: { title } });

  await expect(todo).toHaveCount(0);
  await expect(otherTodo).toBeVisible();
  await expect(otherTodo).not.toBeChecked();
  ```

  Before running the file, check every list-mutation test acts on the second
  item shown. Read-only lists can target an existing non-first item; tests
  explicitly about position 1 can act on the first item.
- **Refusals and multi-user delivery.** When a refusal promises no persisted
  write, wait for the refusal message (or assert it in its own test), reopen
  after an independent readiness wait, and assert records stayed unchanged;
  put a follow-up retry in its own test.
  For recipient delivery, keep a separate recipient session open and scope
  checks to the run-unique message (and history after reopen if promised).
- **Each test owns its starting state and passes alone.**
  - **Client vs. server state:** browsers isolate contexts per test (restoring
    `session` state without leaking earlier tests' client changes); on Android
    and iOS simulators, reset with `app.clearState()` (plus
    `device.clearKeychain()` on iOS simulator when sign-in uses keychain; on a
    physical iPhone, `app.clearState()` is simulator-only, so reinstall with
    `device.installApp(path, { reinstall: true })`).
  - **Fixture-owned server data:** create shared server records with a
    run-unique `randomUUID()` name in a `test.extend` fixture, capture the
    returned id from a 2xx response before asserting the exact status, and
    delete it in `finally` (`try`/`finally` around creation and `use()` cleans
    up partial setup once the fixture obtains a usable id, as well as failed
    tests). Even when a test deletes its record, keep fixture teardown and
    accept `404` so an earlier failure never leaks. Without a test API, seed
    and delete through the UI in the fixture; never clean up at the end of a
    test body.
  - **No coupling or unwaited branching:** never chain tests across shared
    state, never use `serial: true` to hide coupling, and never branch or skip
    on `isVisible()`/`count()` (they do not wait). Every test must pass when
    run alone by `file:line`, twice in a row.
- **Name and reuse what the tests repeat.** Check existing `tests/`, fixtures,
  helpers, and [page objects](https://e2e.com/docs/page-object-model) first
  and reuse or extend them (including existing screen helpers or page objects
  the project already uses) instead of duplicating setup. Define repeated
  selector inputs, values, or prompts once inside `describe` (or a
  feature-local module as specs grow) and keep single-use ones inline; bind
  repeated locators to local `const`s. Pass variables to prompts in `params`
  (`unique()` for run-unique values so the replay cache hits).
- **Prefer `agent.act` when a model is configured.** When `e2e.config.ts`
  configures a model or custom executor on `agents.default` (or on a named
  `agents.<name>`, selected with `{ agent: '<name>' }` on the test or
  `--agent <name>` on the CLI), default to `agent.act` for user flows (forms,
  buttons, list/CRUD mutations, navigation, auth, with values in `params`),
  and do not avoid `agent.act` on new user flows merely because a `test.setup`
  or login file uses `screen.*`. Pair `agent.act` with verifying checks at the
  end so eligible confirmed `act` steps record and replay without new `act`
  model calls (model-backed judgments such as `agent.assert` still call the
  model on reruns). Reserve `screen.*` actions for low-level mechanics that
  are themselves under test (such as `ignores an empty submission` above, a
  keyboard shortcut, or a drag offset), a `test.setup` sign-in form, or a
  project with no model configured. Use `expect` for exact values, counts, or
  field states; use `agent.assert` alone when the screen shows the full
  semantic or visual outcome, pairing a deterministic `expect` when exact
  phrasing or state must also hold (topic `debugging`, "Flaky tests"). A
  passing locator/engine matcher, `locator.waitFor`, `agent.assert`, or
  `agent.waitFor` confirms preceding `agent.act` steps for the replay cache
  (`expect.poll` and plain-value `expect` confirm nothing).

## Registration

`test` registers everything, and `describe`, `beforeEach`, `afterEach`,
`beforeAll`, and `afterAll` are also top-level imports of the same functions
(`import { describe, beforeEach } from 'e2e'`; `@e2e-dev/web`,
`@e2e-dev/mobile`, and `@e2e-dev/desktop` export `test`, `describe`, and the hooks typed with their fixture; a
`test.extend()` chain registers hooks that see its fixtures through
`test.beforeEach`). Everything registers at import, so a `describe` body is
synchronous (`async` is a `COLLECTION_ERROR`).

```ts
test('title', async ({ app, screen }) => {});
test('title', { tags: ['smoke'], retries: 2, timeout: 60_000 }, async ({ app }) => {});
describe('group', { tags: ['billing'] }, () => { /* tests and hooks */ });
describe('checkout flow', { serial: true }, () => { /* ordered, shared app state */ });
beforeEach(async ({ app }) => {});     // per attempt, with test fixtures
afterEach(async ({ screen }) => {});   // runs after failures too, with its own cleanup budget
beforeAll(async ({ platform }) => {}); // per suite realm, worker fixtures only (device, app, screen on mobile)
afterAll(async () => {});
test.skip('later', async () => {});
test.only('focus', async () => {});         // local only: CI fails with ONLY_IN_CI
test.skipIf(process.platform === 'win32')('watcher', async () => {}); // condition read at collection: truthy registers it skipped, as { skip: true }
test.runIf(process.env.CI)('ci only', { tags: ['ci'] }, async () => {}); // test.skipIf(!condition)
test.each([{ user: 'Ada' }, { user: 'Grace' }])('signs in as $user', async ({ user }, { app }) => {}); // one test per row; rows that are all arrays are spread: (a, b, { app }), any other table passes each row whole; the fixtures are destructured after the row; titles take $key, %s, %i, %#
test.for([['standard', '5.00']])('ships %s for %s', async ([speed, price], { app }) => {}); // test.each without the spread: (row, { app })
test('conditional', async () => { test.skip(await onlyOneOrg(), 'nothing to switch to'); }); // throws: the body stops here, reported skipped; call it before the first step
test('later', async () => { test.skip('waiting on the API'); }); // bare skip from the body
test.fixme('not yet', async () => {}); // test.skip's three forms; reported skipped with cause "fixme" and reason "fixme", or "fixme: <reason>" from test.fixme(reason) or test.fixme(cond, reason) in a body
test.todo('add checkout coverage'); // no body; reported skipped with cause and reason "todo", without running
test('big import', async () => { test.setTimeout(180_000); }); // body or beforeEach: the attempt's timeout, counted from its start; in beforeAll: that hook's own
test('slow sync', async () => { test.slow(); }); // triples the timeout in force, once per attempt; test.slow(condition, reason) only when true
test.fail('known gap', async () => {}); // expected to fail: a test failure passes it, a pass fails it with UNEXPECTED_PASS
test('gap on web', async ({ platform }) => { test.fail(platform === 'web', 'known gap'); }); // marks, does not throw; the body runs on
describe.fail('legacy', () => {}); // every test inside expected to fail; a reason: describe('legacy', { fail: 'reason' }, fn)
describe.only('checkout', () => { test('pays', async () => {}); }); // local only: every test inside focused; CI fails with ONLY_IN_CI
test.setup('sign in', { sessions: ['admin'] }, async ({ app, screen, session }) => {}); // see Sign-in sessions
const wsTest = test.extend<{ ws: Ws }>({ ws: async ({ browser }, use) => { await use(await seed()); await drop(); } });
wsTest('uses the workspace', async ({ ws }) => {}); // code after use() is teardown, runs after failures too
const dbTest = test.extend<{}, { db: Db }>({ db: [async ({}, use) => { await use(await startDb()); }, { scope: 'worker' }] });
dbTest.beforeAll(async ({ db }) => { await db.seed(); }); // one db per worker, torn down when the worker ends
```

A setup test cannot skip from its body (`INVALID_ARGUMENT`), and neither a
setup test nor a serial member can call `test.fail`. `test.fail` covers test
failures and timeouts only: an infrastructure error such as `ENGINE_FAILURE`
or a blocked agent verdict still fails the test.

| Option | Default | Notes |
| --- | --- | --- |
| `timeout` | `config.timeout`, 120 s | Covers `beforeEach` and the body. |
| `retries` | `config.retries` | 0 to 10; a serial group's value applies to its members. |
| `tags` | `[]` | Distinct, non-blank, no comma or edge whitespace (`'Login Form'` is fine); union across layers. `--tag smoke` selects, `--tag-mode all` requires every tag. |
| `skip` | unset | `true` or a reason string. |
| `fail` | unset | `true` or a reason string: expected to fail, as `test.fail`. On a group, marks every test in it; not on setup tests or on, inside, or around a serial group. |
| `platforms` | unset | Only targets with these platforms, e.g. `['ios']`. |
| `session` | unset | Restore state saved by a setup test. |
| `agentContext` | unset | Extra context for `agent.*` calls in this test or group. |
| `agent` | the run's agent | A configured name (`agents.<name>`) or a list run once per agent; `--agent` narrows the list, a setup test takes one name. Innermost wins; `agent.act(..., { agent })` names another for one call. |
| `trace`, `video` | the target's | `'off'`, `'on'`, `'retain-on-failure'`, `'on-first-retry'`, `'on-all-retries'`: whether the test keeps a trace page, which attempts record video. Innermost wins over `--trace` / `--video`, the target, and the config; video where the engine cannot record is `UNSUPPORTED_ARTIFACT` for the run. |
| `serial` | `false` | Groups only. Members share app state, run in order on one worker, retry as a whole, and take the group's `trace` and `video`. |
| `parallel` | unset | Groups only. `true` runs the group's tests at the same time on separate workers (a file's tests otherwise run in order on one); `false` keeps a group in order inside a parallel scope. `describe.configure({ parallel: true })` at the top of a file sets it for the file, `fullyParallel: true` in the config for every file. A worker imports the file one time for the tests it runs apart, so they share the file's state on that worker and not across workers: keep no state in the file that one test leaves for another. Tests with `beforeAll` or `afterAll` hooks around them run in batches, at most as many as the target has workers, and each batch runs the hooks one time. |

Serial members cannot set `retries`, `trace`, `video`, `session`,
`platforms`, `skip`, `fail`, or `only`, nor can a nested `describe` set
`trace`, `video`, `fail`, or `only`; nesting serial groups is a `COLLECTION_ERROR`.

Hooks nest: outer `beforeEach` first, inner `afterEach` first. `beforeAll`
reruns per retry and per serial group (each a fresh module realm) on the
test timeout; `afterAll` runs on `config.cleanupTimeout`. A failing
`beforeAll` is a `HOOK_FAILED` run error skipping every test in its scope.
`beforeAll` and `afterAll` get worker fixtures only: `platform`, worker
fixtures from `test.extend`, and on mobile `device`, `app`, and `screen`
(a device keeps its state between tests). On web, `browser`, `app`, and
`screen` are test fixtures, so UI setup goes in `beforeEach`. Naming a test
fixture in a suite hook is a `COLLECTION_ERROR` naming it. On mobile a suite
hook that names none of `device`, `app`, `screen` opens no device attempt; when no device
attempt can open for the hooks or the run was interrupted, they still run and
reading `device`, `app`, or `screen` throws the reason.

## Fixtures

Find the module that exports the project's fixture-aware `test`. Choose
the spec's final path before writing the import, then resolve the import
from the spec's directory. Run that spec after adding or moving it and
confirm the runner collects and executes the intended test.

Fixtures are set up on demand. A test body, a hook, and a fixture function
name what they use by destructuring their first parameter
(`async ({ app, screen }) => {}`), a `test.each` or `test.for` body the one
after its row; `async (fixtures) => {}`, `async (_, use)`,
a rest property, and a bound function (`fn.bind()`) are `COLLECTION_ERROR`, and a fixture that needs nothing
takes `({}, use)`. A test sets up the `test.extend` fixtures its body and its
`beforeEach` and `afterEach` hooks name, and the ones those fixtures name
(same `extend` call or an earlier one, any order; a cycle is
`COLLECTION_ERROR`). A fixture nothing names does not run: one that exists
for its side effect takes `[fn, { auto: true }]`, set up for every test, or
`[fn, { scope: 'worker', auto: true }]`, once per worker.

`test.extend` fixtures initialize before `beforeEach` and still run their
`finally` teardown when `beforeEach` calls `test.skip(...)`. Guard teardown
with a `created` or `mutated` flag (or clean up only what this attempt wrote)
so skipped or failed-before-mutation attempts never touch shared state. To
route tests across same-platform targets (such as desktop vs. mobile
viewports), tag tests (`{ tags: [...] }`) and run each target with
`--target <name> --tag <tag>` rather than sniffing `window.innerWidth` or
`timeZone` in `beforeEach` (which boots every test on every target and turns
a misconfigured target into a green skip).

If you name a fixture that isn't on any target in the config, the run fails
at collection.

You can use `device` in the same test on web and iOS. On web, `device` is
`undefined`. If you override `device`, your override is called on web too,
with `device` set to `undefined`.

To type fixtures across targets:

1. Use `as const satisfies E2EConfig` or `defineConfig` on the config
   object, not a type annotation, to keep the inferred engine types.
2. Import the config type with `import type config from '../e2e.config.ts'`.
3. Pass `typeof config` as the third type argument of `test.extend`:
   `base.extend<{}, {}, typeof config>()`.

Check `platform` or the fixture value to narrow the fixture type. With
`platforms` on a test, it's narrowed too. On a `describe`, it isn't.

An `afterEach` that names a fixture whose setup failed is skipped. A fixture
named like one the `test` already has, built-in ones included, extends it
(`app: async ({ app }, use) => { await app.open('/x');
await use(app); }`, no type argument): inside it the name is the previous
value, everyone else gets what it passes to `use`, and it keeps that
fixture's type. Its scope and `auto` are the ones its options set, else a
test fixture set up on demand, even when it extends a worker fixture (for a
`device` override that runs once per worker and reaches `beforeAll`, pass
`{ scope: 'worker' }`). A worker
fixture (`[fn, { scope: 'worker' }]`, second type argument of `extend`) is
set up once per worker and target by the first test or suite hook that names
it, torn down when the worker ends, and sees worker fixtures only. Declare it in a module the test files import: a test
file reloads after a failure and for each serial group and setup test, and a
worker fixture it declares gets a new
instance while the old one stays set up until the worker ends.

`app` (`App`) and `screen` (`Screen`): always. `agent` (`Agent`): needs a
configured model, else `MODEL_UNAVAILABLE` (topic `agent`). `platform`
(`string`): always, hooks included; `web`, `ios`, `android`, or an engine's
label. `browser` (`Browser`): browser targets, import `test` from `@e2e-dev/web`.
`device` (`Device`): device targets, import `test` from `@e2e-dev/mobile`.
`desktop` (`Desktop`): desktop targets, import `test` from `@e2e-dev/desktop`.
`session` (`SetupSession`): only in `test.setup`.

### app

- `baseUrl` (`string | undefined`): the target's app URL with the run's
  port and no trailing slash (`${app.baseUrl}/api/users`); `undefined` when
  the target declares no `app.url`. `string` with `test` from `@e2e-dev/web`.
- `open(path?)`: opens the target's `app.url`, a relative path, or an absolute
  http(s) URL. On a device it relaunches the pinned app, and a path opens as
  a link in it only when the target declares `app.linkBase`.
- `back()`: one history step back.
- `restart()`: recreates the context keeping persisted state (a restored
  session included), then reopens the base URL.
- `clearState()`: clears cookies and storage, recreates the context, reopens
  the base URL.
- `screenshot(label?)`: saves a redacted screenshot artifact and returns its
  absolute path; the `list` summary names the first 10 under `Screenshots`. It masks
  secure fields only (see Sign-in sessions).
- `startRecording({ name? })`, then `stopRecording()`: records one span and
  returns its videos (`path` or hosted `url`). Fails while the test's
  `video` records: set `{ video: 'off' }` on the test.

`clearState()` is `UNSUPPORTED_CAPABILITY` with `connect.reconnectEndpoint`
or an attempt-scoped browser provider; on a device with no pinned `app`, both
methods are.

## Locators

`screen.getBy*` builds a lazy query, resolved only by an action, read, or
assertion. Every query also exists on a locator, scoped to its subtree.

For a collection check, start at the owning list or table and query only
its items or rows. When the requirement names the whole collection, check
every row in that container, including duplicates. If order can change,
sort copies before comparing the complete observed and expected lists.

| Query | Matches |
| --- | --- |
| `getByRole(role, name?, { exact?, checked?, disabled?, selected?, expanded?, pressed?, level?, visible? })` | Semantic role, optionally by accessible name (`getByRole('button', 'Save')`; the object form `{ name }` works too) and state (`level`: heading level 1 to 6). First choice. |
| `getByLabel(text, { exact?, visible? })` | Form controls by label. |
| `getByPlaceholder(text, { exact?, visible? })` | Inputs by placeholder. |
| `getByText(text, { exact?, visible? })` | Visible text. |
| `getByDisplayValue(value, { exact?, visible? })` | Inputs by current value; on the web it cannot scope child queries or be a `filter({ has })` or `filter({ hasNot })` target. |
| `getByTestId(id, { visible? })` | `data-testid` on the web (or `web({ testIdAttribute })`), accessibility identifier or resource id on a device (React Native `testID`, SwiftUI `.accessibilityIdentifier`, Compose `testTag` with `testTagsAsResourceId` on Android, Flutter `Semantics(identifier:)`, .NET MAUI `AutomationId`, NativeScript `testID`); a string matches the whole id, a RegExp tests it; on Android the `<package>:id/` prefix may be left off. Last resort. |

Roles: `button`, `link`, `textbox`, `searchbox`, `combobox`, `listbox`,
`option`, `checkbox`, `radio`, `radiogroup`, `switch`, `slider`, `spinbutton`,
`progressbar`, `meter`, `image`, `heading`, `tab`, `tablist`, `tabpanel`,
`menu`, `menubar`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `toolbar`,
`tooltip`, `tree`, `treeitem`, `list`, `listitem`, `table`, `grid`, `row`,
`rowgroup`, `rowheader`, `cell`, `gridcell`, `columnheader`, `separator`,
`group`, `article`, `figure`, `form`, `status`, `alert`, `dialog`,
`alertdialog`, `main`, `navigation`, `banner`, `contentinfo`, `complementary`,
`region`. The union is closed (anything else is a type error); `img` aliases
`image`; a role the platform lacks (`tooltip` on a phone) matches nothing.
On the web a `contenteditable` host is a `textbox` for the agent and takes
`fill`; from a test use `getByLabel`, `getByTestId`, or `role="textbox"` on
the host.

The second argument to `getByRole` is the element's accessible name.
For visible text inside an unlabelled list item or status, use
`getByRole('listitem').filter({ hasText: message })` or scope a
`getByText(message)` query to the right part of the screen.

Text matching is exact after whitespace normalization (whole string,
case-sensitive) for a `getByRole` name, `getByLabel`, `getByPlaceholder`, and
`getByText`: `name: 'Save'` misses `Save changes` (unlike Playwright). A
missed query makes a negated assertion pass, so check it positively.
`getByText` and `getByLabel` return the innermost match, so a container
echoing its child does not count twice. `exact: false` is a case-insensitive
substring; a `RegExp` matches as written.

- Exactly one match per action, read, or assertion. Two fail at once with
  `LOCATOR_AMBIGUOUS`; at zero, actions and reads poll until the action
  timeout then `LOCATOR_NOT_FOUND`, assertions until the assertion timeout
  then `ASSERTION_FAILED`. Zero-match exceptions (still `LOCATOR_AMBIGUOUS`
  on two or more matches): `toBeVisible`, `toBeHidden`, `toBeAttached`,
  `toBeInViewport` (negated `.not.toBeInViewport()` passes at zero; positive
  polls to timeout, like `toBeVisible` and `toBeAttached`), `isVisible()`
  (false at zero), `isHidden()` (true). Multi-match exceptions (zero or more
  matches allowed): `toHaveCount`, list-form `toHaveText` and `toContainText`,
  `count()`, `all()`, `allTextContents()`.
- Narrow with `filter({ hasText })` (a case-insensitive substring, unlike a
  query), `filter({ hasNotText })` to exclude matching subtree text,
  `filter({ has: locator })`, `filter({ hasNot: locator })`, `first()`,
  `last()`, `nth(i)`, or scoping under another locator. Any other `filter`
  key (`visible`) or an empty `filter({})` is `INVALID_LOCATOR`. `a.or(b)`
  matches either, still strict: add `first()` when both may match. Both
  locators must come from the same screen and attempt. Web branches need
  identical literal frame-selector chains; display-value branches cannot be
  composed.
- `visible: true` drops nodes the page hides (a closed drawer) before the
  exactly-one rule. Visibility is what renders, as `toBeVisible()` reads it:
  an `aria-hidden` spinner that paints is visible, so `toBeHidden()` waits
  for it to go. A closed `<details>` body and content under
  `content-visibility: hidden` are hidden through shadow roots and slots too,
  unless the page's CSS still shows them.
- On the web, queries reach open shadow roots and closed roots attached with
  `attachShadow`, not declarative closed roots. `browser.locator(css)`,
  `frameLocator`, and `filter({ hasText })` stop at a closed root; query the
  text inside or filter with `has`.
- `screen.scrollUntilVisible(locator, { direction?, momentum?, timeout? })`
  scrolls the viewport (`down`, `slow` by default) until the locator resolves
  visibly, else `LOCATOR_NOT_FOUND`; on a locator it scrolls that node.

### Actions

Each action resolves one node, waits up to `config.actionTimeout` (30 s, or
`{ timeout }`) for it to be actionable, and does one thing: `tap()` (alias
`click()`; `{ count: 3 }` taps three times in a row, a triple click in a
browser; `count` is a positive safe integer, `2` is `doubleTap()`, 3 or more
need the engine's `multiTap` (browser and mobile have it; mobile refuses more
than 200), and a count above 1 doesn't combine with `position`),
`doubleTap()` (alias `dblclick()`),
`secondaryTap()` (each takes `{ modifiers: ['Shift'] }`),
`longPress({ duration? })`
(100 to 10000 ms; default 500 on the web, 1000 on a device),
`fill(value | Secret)`, `pressSequentially(text, { delay? })`, `clear()`,
`press(key)`, `check()`, `uncheck()`,
`selectOption(label | { label } | { value } | { index })` (one option; an
array is `INVALID_ARGUMENT`), `focus()`, `blur()`, `hover()`, `setInputFiles(files)`
(paths relative to the project root, or `{ name, mimeType, buffer: Buffer }` payloads, singly or as an array; `[]` clears; a missing path, or one under a directory the runner cannot search, is `INVALID_ARGUMENT`), `dragTo(locator)`, `scrollIntoView()`,
`swipe({ direction, momentum? })`. Web only, `UNSUPPORTED_CAPABILITY` on a
device: `blur`, `secondaryTap`, `selectOption`, `setInputFiles`, `scrollIntoView`,
and `modifiers`.

`fill` sets the value with no key events; when the app reacts to keystrokes
(autocomplete, a masked input) use `pressSequentially`, which focuses the
field and types one character per `delay`, plain string only (a `Secret` is
`INVALID_ARGUMENT` and goes through `fill`).

Coordinates are CSS pixels, for what the tree does not list: `tap({ position:
{ x, y } })` offsets from the node's top-left corner inside its border (with `modifiers` it is
`INVALID_ARGUMENT`), `screen.tapAt({ x, y })` taps a viewport point,
`screen.doubleTapAt({ x, y })` double-taps a viewport point,
`screen.swipe({ from, to, duration? })` swipes along a path (on iOS an
untimed one must stay above the open soft keyboard; pass `duration` to drag
across it),
`screen.swipe({ direction, momentum? })` swipes the viewport. Viewport
points also take percentages from `'0%'` through `'100%'`, rounded to the
nearest pixel: `{ x: '50%', y: '50%' }`. Prefer a locator; a point moves with
the layout.

### Reads

`textContent()`, `inputValue()`, `getAttribute(name)`, `isEnabled()`,
`isDisabled()`, `isChecked()`, and `boundingBox()` wait for one match until
the action timeout, then read once with no retry for a value. `isVisible()`,
`isHidden()`, and `count()` answer at once. `all()` gives one
`nth(i)` locator per current match and `allTextContents()` every match's
text, both `[]` at zero. Text is the rendered text, whitespace collapsed: on
the web what `innerText` reads (`text-transform` applies, `display: none`
drops out, `<br>` is a space); `toHaveText` reads the same. `isChecked()` on a
node that cannot be checked (a button), and `inputValue()` on one that holds
no value (a heading), throw `ACTION_FAILED`. `waitFor({ state?: 'attached' | 'detached' | 'visible' | 'hidden', timeout? })` waits
within `actionTimeout`, else `LOCATOR_NOT_FOUND`. For a value that has to
settle use `expect`, not a read. Reading a secure field's value or
attributes is `POLICY_DENIED`, as is `toHaveAttribute` on one, negated too.

`screen.tree()` returns the whole screen as the agent reads it (one node
per line, secrets redacted) and `screen.debug()` prints it to the test's
output. Both read once without waiting. A locator does not have them, and
a frame throws `INVALID_ARGUMENT`.

## expect

`expect(locator)` polls up to `config.assertionTimeout` (5 s) or
`{ timeout }`; `.not` inverts and passes once the negation has held 1 s
continuously, or for the whole `timeout` when that is shorter, so it never
returns sooner. `expect(locator, message?)`, `expect(screen, message?)`, and
their `expect.soft` forms open each assertion failure with the message.
`expect(value, message?)` is synchronous.
Value matchers such as `toMatchObject` check a value and return `void`.
Read a response into a variable, assert on that variable, then use its
properties. Use `toMatchSchema` when you need the parsed value returned
by a matcher.
`expect.poll(read, { timeout?, interval?, intervals?, message? })` re-reads until a value
matcher passes (`assertionTimeout` and `[100, 250, 500, 1000]` ms by default, stopping with the
attempt); a throwing read keeps polling, and it is not a report step. A
poll that the body or a hook returns without awaiting is cancelled and fails
that phase with `STEP_NOT_AWAITED`.
Use `intervals: [<ms>]` in place of the deprecated `interval` option.
`timeout: 0` on a locator or fixture action, `waitFor`, a matcher, or
`expect.poll` sets no deadline of its own: the test timeout
(`cleanupTimeout` in `afterEach`) still bounds it, and `expect.poll` with 0
outside a test, hook, or hosted session is `INVALID_CONFIG`. A negative or non-finite `timeout` is
`INVALID_ARGUMENT` (`INVALID_CONFIG` from `expect.poll`); `agent.*` calls
take a positive `timeout` only.

Use `await expect(fn, message?).toPass({ timeout?, intervals? })` when
several assertions must pass together. The block is retried until it
completes without throwing. Use hard assertions inside the block. Keep
inner locator timeouts short. With `.not.toPass()`, the assertion
passes on the first throw or rejection. With `expect.soft(fn).toPass()`,
you can keep a timeout failure and continue the test body.

Set call options to override the corresponding fields in `config.toPass`.
The defaults are the phase deadline and pauses of `[100, 250, 500, 1000]` ms.
Pass a positive `timeout` outside an attempt or hook. In the report, you
can see the steps from each try, including failed steps. At the cutoff,
running steps in a `toPass` try or poll read are cancelled.

The config defaults and hook deadline apply to both `expect.poll` and
`toPass` in `beforeAll`, `afterAll`, and worker fixture teardown. A call
`timeout` above 2147483647 ms is `INVALID_CONFIG`.

`expect.soft(x)` keeps a failure instead of throwing; the attempt fails
after the body with every soft failure listed. If the body then calls
`test.skip`, the attempt still fails, with the skip reason in its `skip`.
A retry that skips after an earlier failed attempt stays skipped; the CLI shows
it under `Skipped After Failure`, and `failOnSkippedFailure: true` in the
config fails the run with exit code 1. The default is `false`.
`expect.any(Class)`, `expect.anything()`, `expect.objectContaining(obj)`,
`expect.arrayContaining(arr)`, `expect.stringContaining(s)`, and
`expect.stringMatching(s | RegExp)` stand in for values inside `toEqual`,
`toMatchObject`, `toContain`, and `toHaveProperty`.

```ts
await expect(screen.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 });
await expect(browser).toHaveURL('/dashboard');   // relative to the base URL, or a RegExp
expect(order).toMatchObject({ id: expect.any(Number), lines: [{ sku: 'a' }] });
expect.soft(await screen.getByTestId('tax').textContent()).toBe('$8.00');  // kept, body runs on
expect(response).toBeOK();                                  // a request, waitForResponse, or route.fetch() response; status 200-299
const users = expect(await response.json()).toMatchSchema(z.array(User)); // any Standard Schema; typed output
```

`toMatchSchema(schema)` takes a synchronous Standard Schema (Zod, Valibot,
ArkType), fails listing every issue by path, and returns the parsed value
typed; prefer it when the app already has a schema for the response.

| Locator matchers | Browser matchers | Value matchers |
| --- | --- | --- |
| `toBeVisible`, `toBeHidden`, `toBeInViewport`, `toBeAttached`, `toBeEnabled`, `toBeDisabled`, `toBeEditable`, `toBeChecked`, `toBeSelected`, `toBeExpanded`, `toBeFocused`, `toBeEmpty`, `toHaveText`, `toContainText`, `toHaveValue`, `toHaveAttribute`, `toHaveCount`, `toHaveAccessibleName`, `toHaveRole`, `toHaveScreenshot` (also on `screen`) | `toHaveURL`, `toHaveTitle`, `toHaveClass(locator, expected)` | `toBe`, `toEqual`, `toMatchObject`, `toBeTruthy`, `toBeFalsy`, `toBeNull`, `toBeUndefined`, `toBeDefined`, `toHaveLength`, `toHaveProperty`, `toContain`, `toMatch`, `toBeGreaterThan`, `toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`, `toBeCloseTo`, `toMatchSchema`, `toBeOK` |

`toHaveText` compares the whole normalized text, `toContainText` a substring
or RegExp, `toHaveValue` a control's value as is, whitespace included
(it fails on a node with none). `toBeEmpty` passes on a field whose value
is `''` (read as is, so a space is not empty) and on any other node with no
text, where hidden text counts on the web, as in Playwright; it takes only
`timeout` and works with `.not`. On a secure field all four are
`POLICY_DENIED`, never a comparison against `''`. List forms:
`toHaveText(['Alpha', /^Beta/])` needs exactly two matches with those texts
in order; `toContainText(['Alpha', 'Beta'])` needs each entry in a distinct
match, in order, extra matches allowed. `toHaveAttribute(name)` checks
presence, `toHaveAttribute(name, value)` the value; `toBeAttached` waits for
a match, hidden or not; `toHaveClass` compares the whole normalized class
list or tests a RegExp; `toBeInViewport({ ratio })` waits for part of a match
(or that share of its box) inside the viewport without scrolling, reads no
match as outside, and on a device fails with `UNSUPPORTED_CAPABILITY` for
`ratio > 0` once the node is on screen. A failed matcher is `ASSERTION_FAILED`,
exit code 1.

Playwright's `{ checked: false }`, `{ enabled: false }`, `{ editable: false }`,
`{ visible: false }`, and `{ attached: false }` flip their matchers, and `{ ignoreCase: true }`
works on `toHaveText`, `toContainText`, `toHaveAccessibleName`,
`toHaveAttribute(name, value)`, and `expect(browser).toHaveURL`. Any other option, `indeterminate` or
`useInnerText` included, is `INVALID_ARGUMENT`, in JavaScript too.

Screenshots: `await expect(screen).toHaveScreenshot('home.png')` compares the
screen, `expect(locator).toHaveScreenshot()` one element's box, against
`<test file>-snapshots/<name>-<target>-<os>.png`, on web, iOS, and Android
alike. Commit the files. The first run writes the file and fails: look at it,
commit it, rerun. A CI run writes nothing into the project and attaches a
missing one at `snapshots/<path>` in the test's results. `--update-snapshots`
(`-u`) writes missing and different files and passes, after an intended UI
change. Options: `threshold`, `maxDiffPixels`, `maxDiffPixelRatio`, `mask`
(locators painted over, for clocks and other changing content), `maskColor`,
`timeout`. A failure attaches `-expected`, `-actual`, and `-diff` images to the
step. Files are per target and OS (`-web-linux.png`): screenshots written on a
Mac never serve Linux CI, so write CI's from a CI job with `-u`.

## Sign-in sessions

Save sign-in state under a name in a setup test, and declare it with
`session`. Selecting a dependent test alone still runs its setup.

For a test of two users interacting, use distinct accounts in separate
sessions. Restore the primary user's named session through `session`.
For the second user, import `launch` from `@e2e-dev/core` and `web` from
`@e2e-dev/web/engine`, call `launch(web(), options)` from the test with a
fresh engine, then `host.newSession()`. `launch(web(), options)` starts a
local default browser rather than reusing target provider options. Sign in
with that user's test credentials and check the outcome on the screen of
the user who should see it. See the [chat example](https://e2e.com/docs/core#open-a-host-inside-a-test)
for sign-in and cleanup. Use `newSession({ state })` only with a core
`SessionState` from `saveState()` or `SessionState.import()`.

```ts
// tests/auth.setup.e2e.ts
import { test } from '@e2e-dev/web';
import { expect, credentials } from 'e2e';

test.setup('authenticate as admin', { sessions: ['admin'] }, async ({ app, screen, session, browser }) => {
  const admin = credentials.user('admin');
  await app.open('/login');
  await screen.getByLabel('Email').fill(admin.username);
  await screen.getByLabel('Password').fill(admin.password);
  await screen.getByRole('button', 'Sign in').tap();
  await expect(browser).toHaveURL('/dashboard'); // prove the sign-in worked before saving
  await session.save('admin');
});
```

```ts
// tests/dashboard.e2e.ts
import { describe, test, expect } from 'e2e';

describe('dashboard', { session: 'admin' }, () => {
  test('opens directly when signed in', async ({ app, screen }) => {
    await app.open('/dashboard');

    await expect(screen.getByRole('heading', 'Dashboard')).toBeVisible();
  });
});
```

- Setup tests are top-level, outside any `describe`; exactly one setup saves a given name and the
  body saves every declared name once (`SESSION_CONTRACT` otherwise). Names
  match `[A-Za-z0-9_.-]{1,128}`.
- A session holds cookies, local storage, and IndexedDB for one run,
  encrypted and deleted at cleanup; server state is not part of it.
- Screenshots, the model's and the artifacts', mask secure fields only,
  after a secret fill too. A generic secret in a plain input, or a value the
  app shows anywhere else (a show-password toggle, a toast), is in the image
  and reaches the model provider: use test credentials.
- Credentials live in the config, values in the environment:

```ts
credentials: {
  admin: { username: 'admin@example.test', password: process.env.ADMIN_PASSWORD ?? '' },
},
```

- A static password or secret needs 6 or more code points, else
  `INVALID_CONFIG` at config load, so an unset variable fails every command.
  A function `password` is read at fill time and redacted only from that fill
  on; `username` is always a string.
- `E2E_USER_<NAME>_USERNAME` and `E2E_USER_<NAME>_PASSWORD` override either
  field per run, even over a function; `<NAME>` is the credential name
  uppercased, every character outside `[A-Z0-9]` as `_`. Two credentials (or
  two secrets) mapping to one variable, `svc-a` and `svc_a`, are
  `INVALID_CONFIG`.
- `credentials.user('admin').password` is a `Secret` with no plaintext
  accessor, named `admin.password` to the agent and in reports; `secrets.get()`
  never returns it (separate namespaces). Only `fill()` and `agent.act` params accept it, stringifying it
  is `INVALID_CONFIG`, and `credentials.user()` outside a run throws
  `AUTH_CREDENTIAL_UNAVAILABLE`.
- Any other sensitive value (an API key) is a `secrets` entry,
  `secrets: { 'stripe-key': process.env.STRIPE_KEY ?? '' }`, overridable with
  `E2E_SECRET_STRIPE_KEY`; `secrets.get('stripe-key')` is the same kind of
  handle, fills any editable input, and is redacted by name everywhere the
  runner writes.
- A registered value passed as a plain string (`process.env.STRIPE_KEY` in a
  title, a URL, a locator, an `agent.act` instruction or param) is redacted
  too: reports, step labels, the executor, and the model see
  `<secret:stripe-key>` (and so does the test id, for a value in a title),
  so the agent cannot type it. Pass the handle.

## Start near the screen under test

Begin each test as close to its screen as the app allows:

- Declare `session` for auth on web (devices have no named sessions; sign in per test), open routes directly (`app.open('/projects/42/settings')`; on devices use `app.linkBase` or `device.openLink(...)`), and seed data via the app's API in a `test.extend` fixture (`browser.cookies(url)` returns only the cookies the browser sends to that URL; check create and delete statuses).

```ts
import { randomUUID } from 'node:crypto';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';

const projectTest = test.extend<{ project: { id: string } }>({
  project: async ({ app, browser, request }, use) => {
    const cookies = await browser.cookies(`${app.baseUrl}/api/projects`);
    if (cookies.length === 0) throw new Error('not signed in: the app has no cookies');
    const headers = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
    let projectId: string | undefined;
    try {
      const created = await request.post(`${app.baseUrl}/api/projects`, { json: { name: `Project ${randomUUID()}` }, headers });
      const parsed = z.object({ id: z.string() }).safeParse(await created.json().catch(() => undefined));
      if (parsed.success && created.status >= 200 && created.status < 300) projectId = parsed.data.id;
      expect(created.status).toBe(201);
      if (!parsed.success) throw parsed.error;
      await use(parsed.data);
    } finally {
      if (projectId !== undefined) {
        const deleted = await request.delete(`${app.baseUrl}/api/projects/${projectId}`, { headers });
        expect([200, 204, 404]).toContain(deleted.status);
      }
    }
  },
});

describe('project settings', { session: 'admin' }, () => {
  projectTest('renames a project', async ({ agent, app, screen, project }) => {
    await app.open(`/projects/${project.id}/settings`); // straight to the screen under test

    await agent.act('Rename the project to {name} and save', { params: { name: 'Atlas' } });
    await screen.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor();
    await app.open(`/projects/${project.id}/settings`); // reopened: the promise is that it is saved

    await expect(screen.getByLabel('Name')).toHaveValue('Atlas');
  });
});
```

Grow multi-screen tests one screen at a time locally with `--retries 0` (outside `CI` so the cache records), keeping titles and passing goal wording stable so confirmed `agent.act` steps replay while you finish the rest. Pass run-unique values to goal `params` via `unique(value)` (topic `agent`).

## The browser fixture (browser only)

Prefer `app` and `screen`; `browser` is for what only a browser has, and a
portable suite declares `platforms: ['web']`. Page methods act on the one
active tab; cookies, routes, and `onDialog` cover the whole browser. A tab
the app opens (`target="_blank"`, `window.open`) opens in the background:
the active tab stays where it was. `waitForPopup(() => trigger)` makes the
tab the trigger opens active and resolves with it. When the active tab
closes, its opener is active again, or the tab active most recently when
the opener is gone. `tabs()`, `newTab()`, `tab.activate()`, and
`tab.close()` move between tabs.

- `goto(url, { waitUntil?, timeout? })`, `reload({ timeout? })`,
  `back({ timeout? })`, `forward({ timeout? })`: navigation on the test
  timeout by default; `goto` takes a base-relative path.
- `url()`, `title()`, `waitForURL(url | RegExp, { timeout? })`: reads and a
  URL wait; `waitForURL` takes a URL glob such as `'**/checkout'` or a
  `RegExp`, and `toHaveURL` compares a string exactly.
- `locator(css)`: raw CSS or XPath; not portable, a last resort.
- `frameLocator(css)`: a `Screen` scoped to one iframe
  (`browser.frameLocator('#payment').getByLabel('Card number')`); keeps
  `locator(css)` and `frameLocator(css)` for nesting. The agent's tree
  leaves out a frame from another site, so script steps there with it.
- `evaluate(fn | source, arg?)`: runs a function or source string in the
  page, JSON in and out, no closures; a throw in the page is
  `EVALUATE_FAILED`.
- `addInitScript(source | { path } | fn)`, `addInitScript(fn, arg)`: runs
  before the page's own scripts; call it before `app.open`. `arg` is JSON.
- `route(pattern, handler)`, `unroute(pattern)`: intercept requests, newest
  route first; `pattern` is a URL pattern or `{ method, url }` for one method.
  `route.request` has `url`, `method`, `headers`, `postData`.
  `route.fetch()` reads upstream without deciding the route and returns
  `{ url, status, headers, body(), text(), json() }`; redirects are not followed.
  Hand binary bodies on with `body()`, never `text()`.
  The handler calls exactly one of
  `fulfill({ status?, headers?, contentType?, json | body | path })` (`body`
  a string or bytes; several cookies as one `\n`-joined `set-cookie`),
  `continue({ url?, method?, headers?, postData? })` (straight to the
  network; a header set to `undefined` is dropped, the configured `headers`
  still added on an allowed origin), `fallback()` (the route registered
  before it), or `abort()`;
  none or two fails the next step with `ACTION_FAILED`, an unsupported
  option with `INVALID_ARGUMENT`.
- `unrouteAll()` removes every route; configured headers stay.
- `waitForResponse(pattern | predicate, { timeout? })`: returns a
  `PageResponse` with `{ url, status, headers, request, body(), json(),
  text() }`. Only the body readers are methods; `headers` has lower-cased names
  without cookies. Resolves on headers unless a predicate reads the body. On
  the returned response, body readers get `config.actionTimeout` capped by the
  test deadline and reject with `ACTION_FAILED` if the body cannot be read. An
  empty body gives an empty `Buffer` from `body()`, `''` from `text()`, and a
  rejection from `json()`.
- `waitForRequest(pattern | predicate, { timeout? })`: resolves when the page
  sends the request, before any response, with a `WebRequest` shaped as
  `{ url, method, headers, postData? }`, the same type as `route.request`.
- Start either wait before the triggering action, usually in `Promise.all`.
  Both work before the first `browser.goto` or `app.open`. `timeout` is the
  only option; any other key is `INVALID_ARGUMENT`. Nothing matching in time is
  `ACTION_FAILED`, and a relative pattern with no `app.url` is
  `APP_URL_REQUIRED`. Traces label a function predicate as `predicate`.
- A wait predicate runs per event and returns `boolean | Promise<boolean>`, as
  in `(response) => response.request.method === 'POST' && response.status === 201`.
  Any truthy value matches at runtime, async predicates can run concurrently,
  and the first match wins. Inside a `waitForResponse` predicate, body reads
  share the wait's timeout, so reading a streaming or unclosed body can wait
  until timeout; reads still pending on passed-over responses cancel when the
  wait settles. A thrown error fails the step unchanged: an e2e error keeps its
  code, such as `ASSERTION_FAILED` from `expect` or `ACTION_FAILED` from an
  unreadable body, and any other throw becomes `ERROR`.
- `cookies(urls?)`: every cookie, or only those a request to one URL or a
  list would carry; a relative URL resolves against the app URL.
- `setCookies([...])`: a target is an http(s) URL or a domain.
- `clearCookies({ name?, domain?, path? })`: remove cookies matching every
  string or RegExp filter; no options removes all cookies, other storage stays.
- `setViewport({ width, height })`: resize.
- `emulateMedia({ colorScheme?, reducedMotion? })`: what the page's `@media`
  rules and `matchMedia` read, for the rest of the test. Call it before
  `app.open` to load the page with it; a feature left out keeps its value.
- `setNetwork('offline' | 'online')`: cuts or restores the network of every
  tab and service worker for the rest of the test. A request that reaches
  the network fails, and a navigation to a page no cache holds is
  `ACTION_FAILED`; a page its service worker cached still loads. Every test
  starts online.
- `clock`: Playwright's `page.clock` for every tab: `install({ time? })`,
  `pauseAt(time)`, `resume()`, `runFor(ticks)`, `fastForward(ticks)`,
  `setFixedTime(time)`, `setSystemTime(time)`. Install and pause before
  `app.open`, then `runFor` to fire the page's timers; only the page's time
  moves, the test's timeouts and `expect` polling keep real time.
- `onDialog('accept' | 'dismiss' | handler)`: awaited; resolves to an async
  unsubscribe. Register it before the tap that opens the dialog. A handler
  gets `{ type, message, accept(text?), dismiss() }`, where `type` is
  `alert`, `confirm`, `prompt`, or `beforeunload`, `accept` taking the prompt
  text; no handler, or one that neither accepts nor dismisses, fails the
  next step with `INVALID_STATE`. A throwing handler's unanswered dialog is
  dismissed too, and its error fails the next step.
- `waitForDownload(() => trigger, { timeout? })`: returns
  `{ path, absolutePath, suggestedFilename }`; `absolutePath` names the saved
  runner-side file for reading its contents, including with a hosted browser.
- `waitForDownloads(() => trigger, { count, timeout? })`: calls the trigger
  once and returns `count` of those results in start order.
- `keyboard.press(key)`, `keyboard.type(text)`, `keyboard.down(key)`,
  `keyboard.up(key)`, `mouse.*`: unfocused input. Only `down(key)` holds a
  key or modifier until `up(key)`. `press(key)` presses and releases within
  the call. Prefer `locator.press` and `locator.fill`.
- `webmcp.tools()`, `webmcp.callTool(name, input?)`: the tools the page
  registers through WebMCP (`document.modelContext`), listed and called
  with no model. Needs `web({ webmcp: true })`, Chromium or Firefox, and a page on
  `https:` or `localhost`; on a page without WebMCP both fail with
  `UNSUPPORTED_CAPABILITY`. `callTool` returns the tool's result and fails
  with `ACTION_FAILED` when the page has no such tool, the tool throws, or
  the tool navigates the page or runs out of time before it answers (it may
  have run).
  Both cover the page's main frame only, not its iframes.

A `route`, `unroute`, `waitForResponse`, `waitForRequest`, or `waitForURL` pattern is a glob
string or `RegExp`, in Playwright's grammar (`*` stays within one path
segment, `**` crosses `/`, `{a,b}` is either, `?` is literal); a relative
one resolves against the base URL. `route`, `unroute`, `waitForResponse`, and
`waitForRequest` also take `{ method, url }` to match one HTTP method too,
case-insensitively.
A method matches exactly that method: `GET` does not answer `HEAD`. `unroute`
removes routes registered with the same pattern, method included, rather than
URL-matching them. A predicate function is `INVALID_ARGUMENT` for `route`,
`unroute`, and `waitForURL`.

## Habits

- Prefer user-visible names (roles, labels, text) over `browser.locator` or `getByTestId` (last resort).
- APIs live in the same suite: `request.get('/api/users')` (relative to `app.baseUrl`; `request` sends no browser cookies, so serialize `browser.cookies(url)` into `headers.cookie` as `name=value` pairs joined by `; `, as in the fixture above) plus value matchers on `response.status` and `await response.json()`.
- No sleeps or polling loops: wait for state via locators, `expect` `{ timeout }`, or `agent.waitFor(...)`.
- `await` every step, `expect.poll`, and `toPass`, else `STEP_NOT_AWAITED`.
- Assert required literal fragments with `toContain`, and semantic outcomes (where negation or phrasing can flip meaning) with `agent.assert`.
