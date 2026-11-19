# @e2e-dev/core

Drive a browser or an iOS or Android app from code. `@e2e-dev/core` is the
engines, `screen`, and agent of [e2e](https://github.com/e2e-inc/e2e) without
the test runner: no config file, no report, no `expect`. The test runner,
`e2e`, is built on it.

## When to use it

| You want to | Use |
| --- | --- |
| Write tests and run them locally and in CI, with reports | [`e2e`](https://www.npmjs.com/package/e2e): `npx e2e init` |
| Give a coding agent a live session on your app | The MCP server: `npx e2e mcp` |
| Drive an app from your own program: a script, a scraper, a bot, test data setup | `@e2e-dev/core` |
| Open a second browser or device inside an `e2e` test | `@e2e-dev/core`, from the test |

## Install

Install it beside an engine: `@e2e-dev/web` for browsers, `@e2e-dev/mobile`
for iOS simulators and Android emulators.

```bash
npm install @e2e-dev/core @e2e-dev/web
```

It needs Node.js 22.22.3 or later on 22.x, or 24.8 or later. The agent also
needs the AI SDK: `npm install ai`.

## Drive a browser

```ts
// prices.ts
import { launch } from '@e2e-dev/core';
import { web } from '@e2e-dev/web/engine';

await using shop = await launch(web(), { app: { url: 'https://shop.example.com' } });
await using session = await shop.newSession();
await session.app.open('/products/A-1001');
console.log(await session.screen.getByTestId('sale-price').textContent());
```

```bash
node prices.ts
```

`launch` prepares an engine and returns a host. `newSession()` opens one
isolated session on it, with `screen`, `app`, and the engine's fixture
(`browser` or `device`). `await using` closes both at the end of the block.
On Node.js 22, call `close()` in a `finally` instead.

Import engines from their `/engine` entry, as above. That entry needs no
`e2e`.

## Drive an app on a device

```ts
import { launch } from '@e2e-dev/core';
import { mobile } from '@e2e-dev/mobile/engine';

await using shopApp = await launch(mobile({ platform: 'ios' }), {
  app: { bundleId: 'com.example.shop', linkBase: 'https://shop.example.com' },
});
await using session = await shopApp.newSession();
await session.app.open('/products/A-1001');
```

## Let the agent act

```ts
import { createAgent } from '@e2e-dev/core/agent';
import { gateway } from 'ai';

const agent = createAgent(session, {
  model: gateway('anthropic/claude-sonnet-5-5'),
  cache: { dir: '.shop-bot/cache' },
});
await agent.act('Add the item to the cart', { cacheKey: 'add-to-cart' });
```

With `cache`, `act` records each flow and replays it on the next run with no
model call. Every `act` then names its recording with `cacheKey`.

## API

| Entry | Exports |
| --- | --- |
| `@e2e-dev/core` | `launch`, `SessionState`, `isE2EError`, and the types of a host, a session, `screen`, `app`, and locators |
| `@e2e-dev/core/agent` | `createAgent`, `defineTool`, and the agent and executor types |
| `@e2e-dev/core/engine` | `defineEngine` and the contract an engine implements |

Everything under `@e2e-dev/core/lib/*` is internal to `e2e` and the engines,
and may change in any release.

`launch(engine, options)` takes:

| Option | Default | Meaning |
| --- | --- | --- |
| `app` | - | `url` for `web()`; `bundleId` or `appPath` for `mobile()` |
| `secrets` | - | Values by name, filled with `host.secret(name)` and redacted from errors and the agent |
| `headed` | `false` | Show the browser window |
| `timeout` | 30000 ms per action, 120000 ms per app open | One timeout for every operation |
| `signal` | - | Cancels the launch and everything on the host |
| `handleSignals` | `true` | Close the host on SIGINT, SIGTERM, and SIGHUP |
| `artifactsDir` | a temp directory | Where screenshots, downloads, and recordings go |
| `cwd` | `process.cwd()` | What paths resolve from |
| `env` | `process.env` | The environment the engine reads |
| `onNotice` | - | Progress outside operations, such as a browser download |

A host holds one session at a time. For parallel work, launch more hosts.
Every failure is an error with a `code`: check it with `isE2EError(error)`.

## Docs

- [Guide](https://e2e.com/docs/core): sessions, saved state, secrets, errors,
  and the agent with its replay cache.
- [Reference](https://e2e.com/docs/reference/core): every option and error.
- [screen](https://e2e.com/docs/reference/screen) and
  [app](https://e2e.com/docs/reference/app): what a session holds.
- [Write an engine](https://e2e.com/docs/writing-an-engine): build on
  `@e2e-dev/core/engine`.
