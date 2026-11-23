/**
 * `browser.webmcp` in a real browser: the tools a page registers through
 * `document.modelContext` (Chromium) or `navigator.modelContext` (Firefox)
 * are listed and called from test code, on the active tab, when the engine
 * launched the browser with `web({ webmcp: true })`. Without the option the
 * same calls say how to turn WebMCP on, and the option is refused where the
 * engine launches no browser. Driven through the engine hooks and the
 * `browser` fixture, as the attempt executor drives them. The Firefox half
 * runs where Playwright's Firefox is installed and is skipped elsewhere.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, firefox } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineCleanupContext, EngineFixtureContext, EngineHandle, OperationContext } from '@e2e-dev/core/engine';
import { web, type Browser, type BrowserName, type BrowserProvider, type WebOptions } from '../../src/index.ts';
import { webmcpLaunch } from '../../src/webmcp.ts';
import { closeRemoteChrome, launchRemoteChrome, type RemoteChrome } from '../helpers/cdp-host.ts';
import { ignoreTrace, noSecrets } from '../helpers/secrets.ts';

/** A page that registers four tools, and one more when `registerLate()` is called. */
const TOOLS_PAGE = `<!doctype html>
<title>tools</title>
<script>
  const context = document.modelContext ?? navigator.modelContext;
  context?.registerTool({
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    annotations: { readOnlyHint: true },
    execute: async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  });
  context?.registerTool({
    name: 'rename',
    description: 'Renames the page',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    execute: async ({ title = 'untitled' }) => { document.title = title; return { content: [{ type: 'text', text: 'renamed' }] }; },
  });
  context?.registerTool({
    name: 'refuse',
    description: 'Always throws',
    inputSchema: { type: 'object' },
    execute: async () => { throw new Error('not today'); },
  });
  context?.registerTool({
    name: 'echo',
    description: 'Says what kind of input it got and resolves with nothing when asked to',
    inputSchema: {},
    execute: async (input) => (input?.silent ? undefined : { content: [{ type: 'text', text: input === null ? 'null' : typeof input }] }),
  });
  window.registerLate = () => context?.registerTool({
    name: 'late', description: 'Registered after load', inputSchema: { type: 'object' },
    execute: async () => ({ content: [{ type: 'text', text: 'late' }] }),
  });
</script>`;

/** What the throwing tools of the odd page throw: text an engine would otherwise read as the browser's own report. */
const BROWSER_LIKE_MESSAGES = {
  closed: 'Target closed',
  destroyed: 'Execution context was destroyed, most likely because of a navigation',
  disabled: 'WebMCP is not enabled',
} as const;

/**
 * A page whose tools resolve with values that are not plain JSON, some of
 * which JSON cannot hold at all, and tools that throw what a browser would say.
 */
const ODD_PAGE = `<!doctype html>
<title>odd</title>
<script>
  const context = document.modelContext ?? navigator.modelContext;
  const cycle = {};
  cycle.self = cycle;
  const values = [
    ['date', () => new Date(0)], ['bigint', () => 1n], ['nan', () => NaN], ['number', () => 42], ['text', () => 'done'], ['jsonText', () => '42'],
    ['inside', () => ({ at: new Date(0), ratio: NaN })], ['bigintInside', () => ({ total: 1n })], ['cycle', () => cycle],
  ];
  for (const [name, value] of values) {
    context?.registerTool({ name, description: 'Resolves with a ' + name, inputSchema: { type: 'object' }, execute: async () => value() });
  }
  context?.registerTool({
    name: 'sparse', description: 'Resolves with undefined inside', inputSchema: { type: 'object' },
    execute: async () => ({ ok: true, detail: undefined, none: null, list: [1, undefined, { gone: undefined }] }),
  });
  for (const [name, text] of Object.entries(${JSON.stringify(BROWSER_LIKE_MESSAGES)})) {
    context?.registerTool({ name, description: 'Throws ' + text, inputSchema: { type: 'object' }, execute: async () => { throw new Error(text); } });
  }
</script>`;

const PLAIN_PAGE = '<!doctype html><title>plain</title><p>no tools here</p>';

/** A page whose tools act and then never answer: one navigates away, one changes the title and hangs. */
const ACTING_PAGE = `<!doctype html>
<title>acting</title>
<script>
  const context = document.modelContext ?? navigator.modelContext;
  context?.registerTool({
    name: 'leave', description: 'Goes to another page', inputSchema: { type: 'object' },
    execute: async () => { location.href = '/plain'; await new Promise(() => {}); },
  });
  context?.registerTool({
    name: 'stall', description: 'Renames the page and never answers', inputSchema: { type: 'object' },
    execute: async () => { document.title = 'stalled'; await new Promise(() => {}); },
  });
</script>`;

function cleanup(): EngineCleanupContext {
  return { signal: new AbortController().signal, timeoutMs: 30_000 };
}

function operation(timeoutMs = 30_000): OperationContext {
  return { signal: new AbortController().signal, timeoutMs, runId: 'run-webmcp', attemptId: 'w1', origin: 'test' };
}

describe('browser.webmcp', () => {
  let server: Server;
  let origin: string;
  let artifactsDir: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/plain' ? PLAIN_PAGE : request.url === '/acting' ? ACTING_PAGE : request.url === '/odd' ? ODD_PAGE : TOOLS_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // `localhost`, not the address: WebMCP needs a secure context, which localhost is.
    origin = `http://localhost:${(server.address() as AddressInfo).port}`;
    artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-webmcp-'));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Boots one engine into a running attempt, with no page open yet. */
  async function boot(options: WebOptions): Promise<EngineHandle> {
    const engine = web(options);
    await engine.init!({
      runId: 'run-webmcp', targetName: 'web', projectRoot: process.cwd(),
      app: { site: 'localhost' }, env: {}, headed: false,
      workerSlot: 0, log: () => undefined, signal: new AbortController().signal,
    });
    await engine.startAttempt!({ attemptId: 'w1', artifactsDir, signal: new AbortController().signal, resolveSecret: noSecrets, ...ignoreTrace });
    return engine;
  }

  async function shutdown(engine: EngineHandle): Promise<void> {
    await engine.endAttempt!(cleanup());
    await engine.dispose!(cleanup());
  }

  /** The engine's `browser` fixture, with the harness parts it reaches stubbed; `timeoutMs` is each operation's budget. */
  function fixtureOf(engine: EngineHandle, timeoutMs?: number): Browser {
    return engine.fixtures!['browser']!({
      operation: () => operation(timeoutMs),
      app: { resolveUrl: (url: string) => new URL(url, origin).href },
      expectable: (target: object) => target,
      fixture: (_name: string, target: object) => target,
      attachArtifact: () => undefined,
    } as unknown as EngineFixtureContext) as Browser;
  }

  const browsers: readonly { name: BrowserName; installed: boolean }[] = [
    { name: 'chromium', installed: true },
    { name: 'firefox', installed: existsSync(firefox.executablePath()) },
  ];

  describe.each(browsers)('with web({ webmcp: true }) in $name', ({ name, installed }) => {
    let engine: EngineHandle;
    let browser: Browser;

    beforeAll(async () => {
      if (!installed) return;
      engine = await boot({ webmcp: true, browser: name });
      browser = fixtureOf(engine);
      await engine.session!.open!(`${origin}/`, operation());
    });

    afterAll(async () => {
      if (installed) await shutdown(engine);
    });

    it.skipIf(!installed)('lists the tools the page registered, as the page describes them', async () => {
      const tools = await browser.webmcp.tools();
      // The browsers list them in different orders.
      expect(tools.map((tool) => tool.name).toSorted()).toEqual(['add', 'echo', 'refuse', 'rename']);
      expect(tools.find((tool) => tool.name === 'add')).toMatchObject({
        name: 'add',
        description: 'Adds two numbers',
        inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
        annotations: { readOnly: true },
      });
    });

    it.skipIf(!installed)('calls a tool and resolves with its result', async () => {
      expect(await browser.webmcp.callTool('add', { a: 2, b: 40 })).toEqual({ content: [{ type: 'text', text: '42' }] });
    });

    it.skipIf(!installed)('calls a tool with an empty object when no input is given, and the tool acts on the page', async () => {
      expect(await browser.webmcp.callTool('rename')).toEqual({ content: [{ type: 'text', text: 'renamed' }] });
      expect(await browser.title()).toBe('untitled');
      await browser.webmcp.callTool('rename', { title: 'tools' });
      expect(await browser.title()).toBe('tools');
    });

    it.skipIf(!installed)('gives the tool an object when the input is left out or null, and resolves with null when the tool resolves with nothing', async () => {
      expect(await browser.webmcp.callTool('echo')).toEqual({ content: [{ type: 'text', text: 'object' }] });
      // A null input is sent as an empty object too, so a tool never sees null.
      expect(await browser.webmcp.callTool('echo', null)).toEqual({ content: [{ type: 'text', text: 'object' }] });
      expect(await browser.webmcp.callTool('echo', { silent: true })).toBeNull();
    });

    it.skipIf(!installed)('sees a tool the page registers after load', async () => {
      await browser.evaluate('window.registerLate()');
      expect((await browser.webmcp.tools()).map((tool) => tool.name)).toContain('late');
      expect(await browser.webmcp.callTool('late')).toEqual({ content: [{ type: 'text', text: 'late' }] });
    });

    it.skipIf(!installed)('fails a call to a tool the page does not register, naming the ones it does', async () => {
      await expect(browser.webmcp.callTool('subtract', { a: 1, b: 1 })).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        message: expect.stringMatching(/^browser\.webmcp\.callTool: No WebMCP tool named "subtract"\. Available tools: (\w+, ){3,}\w+/),
      });
    });

    it.skipIf(!installed)('reads a missing tool as missing, whatever its name says', async () => {
      // The message repeats the requested name, which must not be read as the browser's own report.
      for (const missing of ['WebMCP is not enabled', 'execution context was destroyed', 'target closed']) {
        await expect(browser.webmcp.callTool(missing)).rejects.toMatchObject({
          code: 'ACTION_FAILED',
          message: expect.stringContaining(`No WebMCP tool named "${missing}"`),
        });
      }
    });

    it.skipIf(!installed)('fails a call whose tool throws', async () => {
      await expect(browser.webmcp.callTool('refuse')).rejects.toMatchObject({
        code: 'ACTION_FAILED',
        // Chromium reports a fixed message, Firefox the tool's own.
        message: `browser.webmcp.callTool: the tool "refuse" failed: ${name === 'firefox' ? 'not today' : 'Tool execution failed.'}`,
      });
    });

    it.skipIf(!installed)('reads a tool that throws as the tool failing, whatever its message says', async () => {
      await engine.session!.open!(`${origin}/odd`, operation());
      for (const [tool, text] of Object.entries(BROWSER_LIKE_MESSAGES)) {
        await expect(browser.webmcp.callTool(tool)).rejects.toMatchObject({
          code: 'ACTION_FAILED',
          message: `browser.webmcp.callTool: the tool "${tool}" failed: ${name === 'firefox' ? text : 'Tool execution failed.'}`,
        });
      }
      await engine.session!.open!(`${origin}/`, operation());
    });

    it.skipIf(!installed)('refuses a name that is not a non-empty string, and input that is not a JSON object', async () => {
      await expect(browser.webmcp.callTool('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(browser.webmcp.callTool(7 as unknown as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(browser.webmcp.callTool('add', { a: () => 1 } as never)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      for (const [input, kind] of [[42, 'a number'], ['{}', 'a string'], [[2, 40], 'an array']] as const) {
        await expect(browser.webmcp.callTool('add', input as never)).rejects.toMatchObject({
          code: 'INVALID_ARGUMENT',
          message: `browser.webmcp.callTool: input must be an object, got ${kind}`,
        });
      }
    });

    it.skipIf(!installed)('resolves with the result as JSON carries it: an undefined property is left out, and null stays', async () => {
      await engine.session!.open!(`${origin}/odd`, operation());
      // `toStrictEqual`, because `toEqual` takes an undefined property for a missing one.
      expect(await browser.webmcp.callTool('sparse')).toStrictEqual({ ok: true, none: null, list: [1, null, {}] });
      await engine.session!.open!(`${origin}/`, operation());
    });

    it.skipIf(!installed)('reads a result that is not plain JSON from its text, the same in every browser', async () => {
      await engine.session!.open!(`${origin}/odd`, operation());
      const results: Record<string, unknown> = {};
      for (const tool of ['date', 'bigint', 'nan', 'number', 'text', 'jsonText', 'inside']) results[tool] = await browser.webmcp.callTool(tool);
      expect(results).toStrictEqual({
        date: '1970-01-01T00:00:00.000Z',
        bigint: 1,
        nan: 'NaN',
        number: 42,
        text: 'done',
        jsonText: 42,
        inside: { at: '1970-01-01T00:00:00.000Z', ratio: null },
      });
      await engine.session!.open!(`${origin}/`, operation());
    });

    it.skipIf(!installed)('fails a call whose tool resolves with something JSON cannot hold', async () => {
      await engine.session!.open!(`${origin}/odd`, operation());
      for (const tool of ['bigintInside', 'cycle']) {
        await expect(browser.webmcp.callTool(tool)).rejects.toMatchObject({
          code: 'ACTION_FAILED',
          // Chromium reports it as it reports a tool that throws; Firefox hands over the value, so the engine can say more.
          message: expect.stringContaining(
            name === 'firefox' ? `browser.webmcp.callTool: the tool "${tool}" ran, and its result has no JSON form: ` : `browser.webmcp.callTool: the tool "${tool}" failed: Tool execution failed.`,
          ),
        });
      }
      await engine.session!.open!(`${origin}/`, operation());
    });

    it.skipIf(!installed)('lists no tools on a page that registers none, and follows the active tab', async () => {
      const first = browser.tabs()[0]!;
      const tab = await browser.newTab();
      await engine.session!.open!(`${origin}/plain`, operation());
      expect(await browser.webmcp.tools()).toEqual([]);
      await expect(browser.webmcp.callTool('add', { a: 1, b: 1 })).rejects.toMatchObject({ code: 'ACTION_FAILED' });
      await first.activate();
      expect((await browser.webmcp.tools()).length).toBeGreaterThan(0);
      await tab.close();
    });

    it.skipIf(!installed)('says the page is not a secure context when it is served over plain http', async () => {
      await browser.route('http://insecure.test/', (route) => route.fulfill({ body: TOOLS_PAGE, contentType: 'text/html' }));
      await engine.session!.open!('http://insecure.test/', operation());
      const expected = {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/this page has no WebMCP because it is not a secure context; serve it on https: or localhost/),
      };
      await expect(browser.webmcp.tools()).rejects.toMatchObject(expected);
      await expect(browser.webmcp.callTool('add', { a: 2, b: 40 })).rejects.toMatchObject(expected);
      await browser.unrouteAll();
    });

    it.skipIf(!installed)('reports a tool that navigates the page away as possibly committed, and the next navigation goes through', async () => {
      await engine.session!.open!(`${origin}/acting`, operation());
      await expect(browser.webmcp.callTool('leave')).rejects.toMatchObject({
        code: 'ACTION_MAY_HAVE_COMMITTED',
        message: expect.stringMatching(/^browser\.webmcp\.callTool: the page navigated before the tool "leave" answered; the tool may have run/),
      });
      await engine.session!.open!(`${origin}/`, operation());
      expect(await browser.title()).toBe('tools');
    });

    it.skipIf(!installed)('reports a tool the deadline cut off as possibly committed', async () => {
      await engine.session!.open!(`${origin}/acting`, operation());
      await expect(fixtureOf(engine, 2_000).webmcp.callTool('stall')).rejects.toMatchObject({
        code: 'ACTION_MAY_HAVE_COMMITTED',
        message: expect.stringMatching(/^browser\.webmcp\.callTool: the tool "stall" did not answer in time; it may have run/),
      });
      expect(await browser.title()).toBe('stalled');
    });

    it.skipIf(!installed)('reports a deadline that ran out before the tool was called as a plain timeout', async () => {
      await engine.session!.open!(`${origin}/`, operation());
      // The page is busy for longer than the call's budget, so the call never reaches the tool.
      const busy = browser.evaluate('(() => { const end = Date.now() + 3000; while (Date.now() < end); return 0; })()');
      await expect(fixtureOf(engine, 1_000).webmcp.callTool('rename', { title: 'never' })).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      await busy;
      // The abandoned call must not reach the tool once the page is free again; give a late dispatch time to land.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await browser.title()).toBe('tools');
    });
  });

  describe('on a browser the engine attaches to', () => {
    const remotes: RemoteChrome[] = [];

    afterAll(async () => {
      await Promise.all(remotes.map((remote) => closeRemoteChrome(remote)));
    });

    /** Attaches an engine to a Chromium started with `args`, and opens the tools page in it. */
    async function attach(args: readonly string[]): Promise<{ engine: EngineHandle; browser: Browser }> {
      const remote = await launchRemoteChrome(args);
      remotes.push(remote);
      const engine = await boot({ connect: { cdpEndpoint: () => remote.endpoint } });
      await engine.session!.open!(`${origin}/`, operation());
      return { engine, browser: fixtureOf(engine) };
    }

    it('says how to turn WebMCP on when that browser was started without it', async () => {
      const { engine, browser } = await attach([]);
      try {
        const expected = {
          code: 'UNSUPPORTED_CAPABILITY',
          message: expect.stringMatching(/this browser runs without WebMCP; set web\(\{ webmcp: true \}\).*--enable-features=WebMCP/),
        };
        await expect(browser.webmcp.tools()).rejects.toMatchObject(expected);
        await expect(browser.webmcp.callTool('add', { a: 2, b: 40 })).rejects.toMatchObject(expected);
      } finally {
        await shutdown(engine);
      }
    }, 60_000);

    it('lists and calls tools when that browser was started with it', async () => {
      const { engine, browser } = await attach(['--enable-features=WebMCP']);
      try {
        expect((await browser.webmcp.tools()).map((tool) => tool.name)).toContain('add');
        expect(await browser.webmcp.callTool('add', { a: 2, b: 40 })).toEqual({ content: [{ type: 'text', text: '42' }] });
      } finally {
        await shutdown(engine);
      }
    }, 60_000);
  });

  it('says how to turn WebMCP on when the browser runs without it', async () => {
    const engine = await boot({});
    try {
      const browser = fixtureOf(engine);
      await engine.session!.open!(`${origin}/`, operation());
      const expected = {
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringMatching(/this browser runs without WebMCP; set web\(\{ webmcp: true \}\).*--enable-features=WebMCP/),
      };
      await expect(browser.webmcp.tools()).rejects.toMatchObject({ ...expected, message: expect.stringMatching(/^browser\.webmcp\.tools: /) });
      await expect(browser.webmcp.tools()).rejects.toMatchObject(expected);
      await expect(browser.webmcp.callTool('add', { a: 2, b: 40 })).rejects.toMatchObject(expected);
    } finally {
      await shutdown(engine);
    }
  });

  it('launches Chromium with the features Playwright itself turns on, next to WebMCP', async () => {
    // The engine repeats Playwright's list, which Playwright does not export; this fails when a Playwright bump changes it.
    // Chromium reports its command line only when started with `--enable-automation`.
    const plain = await chromium.launch({ args: ['--enable-automation'] });
    try {
      const session = await plain.newBrowserCDPSession();
      const { arguments: args } = (await session.send('Browser.getBrowserCommandLine')) as { arguments: string[] };
      const features = args.find((arg) => arg.startsWith('--enable-features='))?.slice('--enable-features='.length).split(',') ?? [];
      expect(webmcpLaunch('chromium').args).toEqual([`--enable-features=${[...features, 'WebMCP'].join(',')}`]);
    } finally {
      await plain.close();
    }
  });

  it('refuses the option where the engine launches no browser, on WebKit, and when it is not a boolean', () => {
    const provider: BrowserProvider = { name: 'hosted', acquire: async () => ({ id: 'b1', cdpEndpoint: 'ws://127.0.0.1:1' }), release: async () => undefined };
    expect(() => web({ webmcp: true, browser: provider })).toThrow(/web\(\{ webmcp \}\) is a launch setting, and with browser provider "hosted" the engine does not launch the browser/);
    expect(() => web({ webmcp: true, connect: { cdpEndpoint: async () => 'ws://127.0.0.1:1' } })).toThrow(/with connect the engine does not launch the browser/);
    expect(() => web({ webmcp: true, browser: 'webkit' })).toThrow(/web\(\{ webmcp \}\) requires the chromium or firefox browser; WebKit does not implement WebMCP/);
    expect(() => web({ webmcp: true, browser: 'firefox' })).not.toThrow();
    expect(() => web({ webmcp: 'yes' as unknown as boolean })).toThrow(/web\(\{ webmcp \}\) must be true or false/);
    expect(() => web({ webmcp: false, browser: provider })).not.toThrow();
  });
});
