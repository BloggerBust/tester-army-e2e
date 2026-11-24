<a href="https://e2e.com?utm_source=e2e&utm_medium=github&utm_campaign=readme_banner"><img src="./.github/assets/readme-banner.png" alt="e2e, the agentic testing framework" width="100%" /></a>

<p align="center">
  <a href="https://www.npmjs.com/package/e2e"><img alt="npm version" src="https://img.shields.io/npm/v/e2e.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://www.npmjs.com/package/e2e"><img alt="npm monthly downloads" src="https://img.shields.io/npm/dm/e2e.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-green.svg?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://www.skills.sh/e2e-inc/e2e"><img alt="skills.sh installs" src="https://www.skills.sh/b/e2e-inc/e2e?style=for-the-badge&labelColor=000000" /></a>
  <a href="https://e2e.com/discord"><img alt="Join the community on Discord" src="https://img.shields.io/badge/Join%20the%20community-5865F2.svg?style=for-the-badge&logo=discord&logoColor=white&labelColor=000000" /></a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/274762" target="_blank"><img src="https://trendshift.io/api/badge/repositories/274762" alt="e2e-inc/e2e | Trendshift" width="250" height="55" /></a>
</p>

# e2e

[e2e](https://e2e.com?utm_source=e2e&utm_medium=github&utm_campaign=readme_intro) is an end-to-end testing framework for web and mobile apps. Describe a goal in natural language and an agent drives the app to reach it. Check the result with locators and assertions in the same test.

```ts
// tests/checkout.e2e.ts
import { test, expect } from 'e2e';

test('a member upgrades to Pro', async ({ app, agent, screen }) => {
  await app.open('/settings/billing');

  await agent.act('upgrade the workspace to the Pro plan');
  await agent.assert('the invoice preview shows a prorated amount');

  await expect(screen.getByRole('status')).toContainText('Pro');
});
```

Bring your own subscription, API key, or local model.

## A release gate in CI

A suite that gates a release must give the same result every time it runs
on a commit. e2e can run that suite with no model call:

- Your coding agent writes tests with exact locators and assertions. They
  need no model and no key. On the web, they run in Chromium, Firefox, and
  WebKit through Playwright.
- An `agent.act` step that a later assertion verifies records its actions.
  Commit the recordings in `.e2e/cache/` and CI replays them with no model
  call. With `npx e2e run --strict-cache`, a recording that no longer
  matches the app fails the step, and no model takes over. A step that was
  never recorded, or whose recording has a gap, still runs live.
- `expect(locator)` calls no model. With the built-in agent, `agent.assert`,
  `agent.waitFor`, and `agent.extract` call the model on every run.

See [Caching](https://e2e.com/docs/cache) for what replays and when.

## Quick start

```bash
npx e2e init
```

`init` asks for an engine, web or mobile, and a model provider, then writes a
config and an example test. The
[quickstart](https://e2e.com/docs/quickstart) covers the rest.

To see a finished setup in your stack, open
[`examples/`](https://github.com/e2e-inc/e2e/tree/main/examples):
Vite, Next.js, Astro, Angular, Expo, SwiftUI, Jetpack Compose, Kotlin Multiplatform,
Flutter, and .NET MAUI, each a standalone project with a passing suite.

## MCP server

`npx e2e mcp` is a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio. It gives a coding agent such as Claude Code, Codex, or
Cursor a live session on your app, on web, iOS, or Android: the agent sees
the screen, acts on it, gets back the test line that repeats each action, and
runs your suite. The server needs no model.

```json
{
  "mcpServers": {
    "e2e": { "command": "npx", "args": ["e2e", "mcp"] }
  }
}
```

See the [MCP server docs](https://e2e.com/docs/mcp-server) for setup and
every tool.

## Packages

### Core

| Package | What it does |
| --- | --- |
| [`e2e`](https://www.npmjs.com/package/e2e) | The SDK, runner, and CLI. |
| [`@e2e-dev/core`](https://e2e.com/docs/core) | Drives a browser or a device from your own program, with an optional agent and no test runner. `e2e` is built on it. |
| [`@e2e-dev/web`](https://www.npmjs.com/package/@e2e-dev/web) | Browser engine: Chromium, Firefox, and WebKit through Playwright. |
| [`@e2e-dev/mobile`](https://www.npmjs.com/package/@e2e-dev/mobile) | iOS and Android engine: simulators and emulators through agent-device. |
| [`@e2e-dev/desktop`](https://www.npmjs.com/package/@e2e-dev/desktop) | Desktop engine, a prototype: native apps on macOS through agent-desktop. |
| [`@e2e-dev/decision`](https://e2e.com/docs/decision-models) | Decision-model executors for bounded semantic actions and assertions, and `decisionFilter()`, which leaves out the tests a pull request is unlikely to affect. |
| [`@e2e-dev/acp`](https://e2e.com/docs/subscriptions#use-your-coding-agent) | Runs agent steps on your own coding agent (Claude Code or Codex) over the Agent Client Protocol. |

### Integrations

| Package | What it does |
| --- | --- |
| [`@e2e-dev/browser-run`](https://www.npmjs.com/package/@e2e-dev/browser-run) | Cloudflare Browser Run hosted Chromium for the web engine. |
| [`@e2e-dev/kernel`](https://www.npmjs.com/package/@e2e-dev/kernel) | Kernel hosted browsers for the web engine. |
| [`@e2e-dev/notte`](https://www.npmjs.com/package/@e2e-dev/notte) | Notte cloud browsers for the web engine, one session per test attempt. |
| [`@e2e-dev/lightpanda`](https://www.npmjs.com/package/@e2e-dev/lightpanda) | Lightpanda, the open-source headless browser, started per run for the web engine. |
| [`@e2e-dev/moli`](https://www.npmjs.com/package/@e2e-dev/moli) | Local Moli browsers with on-demand layout and screenshots, started per worker slot for the web engine. |
| [`@e2e-dev/smol`](https://www.npmjs.com/package/@e2e-dev/smol) | smol machines browsers for the web engine: by default, each attempt branches a warm Chromium microVM. |
| [`@e2e-dev/testmu`](https://www.npmjs.com/package/@e2e-dev/testmu) | TestMu AI (formerly LambdaTest) hosted Android emulators, iOS simulators, and real devices for the mobile engine, and hosted Chrome and Edge for the web engine. |
| [`@e2e-dev/e2b`](https://www.npmjs.com/package/@e2e-dev/e2b) | E2B sandboxes: Android 16 for the mobile engine, and Chromium for the web engine. |
| [`@e2e-dev/browserstack`](https://www.npmjs.com/package/@e2e-dev/browserstack) | BrowserStack App Automate real Android and iOS devices for the mobile engine. |
| [`@e2e-dev/limrun`](https://www.npmjs.com/package/@e2e-dev/limrun) | Limrun hosted iOS simulators and Android emulators for mobile tests. |
| [`@e2e-dev/revyl`](https://www.npmjs.com/package/@e2e-dev/revyl) | Revyl hosted iOS simulators and Android emulators for the mobile engine. |
| [`@e2e-dev/eas`](https://www.npmjs.com/package/@e2e-dev/eas) | Expo Simulators hosted iOS simulators and Android emulators for the mobile engine. |
| [`@e2e-dev/github`](https://www.npmjs.com/package/@e2e-dev/github) | Reporter that posts results as a pull request comment. |
| [`@e2e-dev/html-reporter`](https://www.npmjs.com/package/@e2e-dev/html-reporter) | Reporter that writes the run as one HTML page, with steps, screenshots, and video. |

### Community

See [Community packages](https://e2e.com/docs/community-packages) for third-party integrations and how to add yours.

## Documentation

[e2e.com/docs](https://e2e.com/docs). The `e2e` package ships
every page, so coding agents can read them offline in `node_modules/e2e/docs`.

## Join us

Join us in changing how software gets tested.
[We are hiring.](https://e2e.com/careers?utm_source=e2e&utm_medium=github&utm_campaign=readme_hiring)

Questions? Ask on [Discord](https://e2e.com/discord). Issues are for bugs
and feature requests.

Want to hack on e2e? See [Contributing](./CONTRIBUTING.md). We prefer an issue
or a Discord discussion before a pull request.

## Security

Please don't open public issues for security vulnerabilities. Follow
[SECURITY.md](./SECURITY.md) and report them to
[security@e2e.com](mailto:security@e2e.com).

## Telemetry

The CLI sends anonymous usage data, such as which commands and engines run and
where runs fail, but no test content, app content, or credentials. Opt out with
`npx e2e telemetry disable` or `E2E_TELEMETRY_DISABLED=1`.
[Telemetry](https://e2e.com/docs/telemetry) lists every field.

## Status

> [!NOTE]
> e2e is in active development on the way to 1.0. APIs and config can still
> change between minor releases.
