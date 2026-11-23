import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineFixtureContext } from '@e2e-dev/core/engine';
import type { PlaywrightSurface } from '../../src/surface.ts';
import { createWebMcp, type WebMcp } from '../../src/webmcp.ts';

const cycle: { self?: unknown } = {};
cycle.self = cycle;

/** What each tool's `execute` resolves with. */
const RESULTS: Readonly<Record<string, unknown>> = {
  object: { ok: true, detail: undefined, none: null, list: [1, undefined] },
  date: new Date(0),
  inside: { at: new Date(0), ratio: Number.NaN },
  number: 42,
  bigint: 1n,
  nan: Number.NaN,
  text: 'done',
  jsonText: '42',
  nothing: undefined,
  function: () => 1,
  bigintInside: { total: 1n },
  cycle,
};

const listed = Object.keys(RESULTS).map((name) => ({ name, description: name }));

/** Firefox's `modelContext`: a call resolves with the value the tool resolved with. */
const valueContext = {
  getTools: async () => listed,
  invokeTool: async (name: string) => RESULTS[name],
};

/** Chromium's `modelContext`: a call resolves with text, and rejects with a fixed message when the result has no JSON. */
const textContext = {
  getTools: async () => listed,
  executeTool: async (tool: { readonly name: string }) => {
    const value = RESULTS[tool.name];
    if (typeof value !== 'object' || value === null) return typeof value === 'function' ? 'undefined' : String(value);
    try {
      return JSON.stringify(value);
    } catch {
      throw new Error('Tool execution failed.');
    }
  },
};

/** `browser.webmcp` over a page that is this process, with `modelContext` as its WebMCP. */
function webmcpOver(modelContext: object): WebMcp {
  vi.stubGlobal('document', { modelContext });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('isSecureContext', true);
  const page = { evaluate: (ask: (call: unknown) => unknown, call: unknown) => ask(call) };
  const surface = {
    requirePage: () => page,
    guard: (operation: unknown, _label: string, run: (operation: unknown) => unknown) => run(operation),
    throughNavigation: (_page: unknown, _operation: unknown, run: () => unknown) => run(),
  } as unknown as PlaywrightSurface;
  const context = { operation: () => ({ signal: new AbortController().signal, timeoutMs: 1_000 }) } as unknown as EngineFixtureContext;
  return createWebMcp(surface, context);
}

describe.each([
  { browser: 'a browser that answers with the value', modelContext: valueContext },
  { browser: 'a browser that answers with text', modelContext: textContext },
])('browser.webmcp.callTool on $browser', ({ modelContext }) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the result from its text', async () => {
    const webmcp = webmcpOver(modelContext);
    const results: Record<string, unknown> = {};
    for (const tool of ['object', 'date', 'inside', 'number', 'bigint', 'nan', 'text', 'jsonText', 'nothing', 'function']) results[tool] = await webmcp.callTool(tool);
    expect(results).toStrictEqual({
      object: { ok: true, none: null, list: [1, null] },
      date: '1970-01-01T00:00:00.000Z',
      inside: { at: '1970-01-01T00:00:00.000Z', ratio: null },
      number: 42,
      bigint: 1,
      nan: 'NaN',
      text: 'done',
      jsonText: 42,
      nothing: null,
      function: null,
    });
  });

  it('fails a call whose result JSON cannot hold', async () => {
    const webmcp = webmcpOver(modelContext);
    for (const tool of ['bigintInside', 'cycle']) {
      await expect(webmcp.callTool(tool)).rejects.toMatchObject({ code: 'ACTION_FAILED' });
    }
  });
});
