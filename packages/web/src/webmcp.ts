/**
 * `browser.webmcp`: the tools a page registers through WebMCP, listed and
 * called from test code, and the launch settings that turn WebMCP on.
 *
 * The engine talks to the page's own `modelContext` from one in-page
 * function, so everything the page answers (the tools, a missing tool, a
 * tool that threw) comes back as data. A call that rejects on the engine's
 * side is then never the tool's own failure: the page navigated, closed, or
 * ran out of time.
 *
 * A result is read from its text, the one form every browser can give.
 * WebMCP hands a result to its caller as text, which is all Chromium gives;
 * Firefox gives the value, so the page function writes that text itself.
 */

import type { Page } from 'playwright-core';
import type { JsonValue } from '@e2e-dev/core';
import { EngineError, TestError, validateJsonValue, type EngineFixtureContext } from '@e2e-dev/core/engine';
import type { BrowserLaunchOptions, BrowserName } from './browser-connection.ts';
import { isClassified, isNavigationRace, translatePwError } from './support.ts';
import type { PlaywrightSurface } from './surface.ts';

/** A tool a page registered through WebMCP, as the page describes it. */
export interface WebMcpTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the tool's input, when the page gave one. */
  readonly inputSchema?: JsonValue;
  /** Hints the page gives about the tool. */
  readonly annotations?: {
    /** The tool changes no state. */
    readonly readOnly?: boolean;
    /** The tool's output may carry third-party content. */
    readonly untrustedContent?: boolean;
    /** The tool takes a consequential action, such as placing an order. */
    readonly consequential?: boolean;
  };
}

/** `browser.webmcp`. */
export interface WebMcp {
  /** Returns the tools the page has registered now. */
  tools(): Promise<readonly WebMcpTool[]>;
  /**
   * Calls one tool with `input`, a JSON object (an empty one when left out or
   * `null`), and resolves with what its `execute` resolved to, usually an object with a
   * `content` array; a result with `isError: true` comes back as it is,
   * and a tool that resolves with nothing gives `null`.
   * Rejects with `ACTION_FAILED` when the page registers no tool of that
   * name, naming the ones it does, when the tool throws or resolves with
   * something JSON cannot hold, and when the call ends before the tool
   * answers, because the tool navigated the page or the time ran out; the
   * tool may have run then.
   */
  callTool(name: string, input?: { readonly [key: string]: JsonValue } | null): Promise<JsonValue>;
}

/** The Chromium argument that turns WebMCP on; also named in the error `browser.webmcp` gives without it. */
const WEBMCP_LAUNCH_ARG = '--enable-features=WebMCP';

/**
 * How each browser is launched with WebMCP: an argument on Chromium, two
 * preferences on Firefox, where the second lets a test read and call the
 * tools. WebKit has no WebMCP, which `web()` refuses before a launch.
 */
export function webmcpLaunch(browser: BrowserName): BrowserLaunchOptions {
  return browser === 'firefox'
    ? { preferences: { 'dom.modelcontext.enabled': true, 'dom.modelcontext.testing.enabled': true } }
    : { args: [`--enable-features=${[...playwrightChromiumFeatures(), 'WebMCP'].join(',')}`] };
}

/**
 * The features Playwright enables in the Chromium it launches (its `enabledFeatures`, which it does
 * not export). Chromium keeps only the last `--enable-features` switch, so the WebMCP one repeats
 * them; without that, turning WebMCP on would turn these off.
 */
function playwrightChromiumFeatures(): readonly string[] {
  return [...(process.env.PLAYWRIGHT_LEGACY_SCREENSHOT ? [] : ['CDPScreenshotNewSurface']), 'SkipListAccountsWithoutGaiaCookies'];
}

/** A tool as the page's `modelContext` lists it. */
interface PageTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly untrustedContentHint?: boolean; readonly consequentialHint?: boolean };
}

/** The part of a page's `modelContext` the engine uses. Firefox calls a tool by name, Chromium by the listed tool. */
interface PageModelContext {
  getTools?(): Promise<readonly PageTool[]>;
  invokeTool?(name: string, input: unknown): Promise<unknown>;
  executeTool?(tool: PageTool, input: unknown): Promise<unknown>;
}

interface PageCall {
  readonly name: string;
  readonly input: unknown;
}

/** How a call ended in the page: the tool threw, resolved with something JSON cannot hold, or gave a result, as its text. */
type PageOutcome = { readonly threw: string } | { readonly unserializable: string } | { readonly text: string };

/**
 * What the page answered. `outcome` is there when a call was asked for and
 * the page still registers the tool.
 */
type PageAnswer =
  | { readonly state: 'absent' | 'insecure' }
  | { readonly state: 'ready'; readonly tools: readonly WebMcpTool[]; readonly outcome?: PageOutcome };

/**
 * Runs in the page: lists the tools of this frame and, given `call`, calls
 * one. Self-contained, because it crosses to the page as source text.
 */
async function askModelContext(call: PageCall | null): Promise<PageAnswer> {
  const holders: readonly object[] = [document, navigator];
  let modelContext: PageModelContext | undefined;
  for (const holder of holders) {
    if (modelContext === undefined && 'modelContext' in holder && holder.modelContext != null) modelContext = holder.modelContext as PageModelContext;
  }
  // A browser that only lets a page register tools gives a test nothing to list or call them with.
  const context = modelContext;
  if (context?.getTools === undefined || (context.invokeTool === undefined && context.executeTool === undefined)) {
    return { state: isSecureContext ? 'absent' : 'insecure' };
  }
  // Chromium lists the tools of every frame, each with its `window`; Firefox lists this frame's.
  const own = (await context.getTools()).filter((tool) => !('window' in tool) || tool.window === window);
  const tools = own.map((tool): WebMcpTool => {
    let inputSchema: unknown;
    try {
      // A schema is JSON; Chromium before 156 hands it over as text.
      inputSchema = JSON.parse(typeof tool.inputSchema === 'string' ? tool.inputSchema : JSON.stringify(tool.inputSchema));
    } catch {
      inputSchema = undefined;
    }
    const annotations = {
      ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
      ...(tool.annotations?.untrustedContentHint === true ? { untrustedContent: true } : {}),
      ...(tool.annotations?.consequentialHint === true ? { consequential: true } : {}),
    };
    return {
      name: tool.name,
      description: tool.description ?? '',
      ...(inputSchema === undefined || inputSchema === null ? {} : { inputSchema: inputSchema as JsonValue }),
      ...(Object.keys(annotations).length === 0 ? {} : { annotations }),
    };
  });
  const tool = call === null ? undefined : own.find((candidate) => candidate.name === call.name);
  if (call === null || tool === undefined) return { state: 'ready', tools };
  const messageOf = (cause: unknown): string => {
    try {
      return String(cause instanceof Error ? cause.message : cause);
    } catch {
      // A thrown value with no text form, such as an object without a prototype.
      return 'the tool threw a value that has no text';
    }
  };
  // The text Chromium gives for a result: JSON for an object, the text itself for a string, and how the value prints otherwise.
  // A function has no text there; neither has a symbol here, which Chromium 159 crashes on.
  const textOf = (value: unknown): string => {
    if (typeof value === 'function' || typeof value === 'symbol') return 'undefined';
    if (typeof value !== 'object' || value === null) return String(value);
    const json: unknown = JSON.stringify(value);
    return typeof json === 'string' ? json : 'undefined';
  };
  let resolved: unknown;
  let text: string | undefined;
  try {
    if (context.invokeTool !== undefined) {
      resolved = await context.invokeTool(call.name, call.input);
    } else {
      try {
        resolved = await context.executeTool?.(tool, call.input);
      } catch (cause) {
        // Chromium before 156 takes the input as JSON text, and refuses an object before the tool runs.
        if (!messageOf(cause).includes('Failed to parse input')) throw cause;
        resolved = await context.executeTool?.(tool, JSON.stringify(call.input));
      }
      // `executeTool` answers with the text already.
      if (typeof resolved === 'string') text = resolved;
    }
  } catch (cause) {
    return { state: 'ready', tools, outcome: { threw: messageOf(cause) } };
  }
  try {
    return { state: 'ready', tools, outcome: { text: text ?? textOf(resolved) } };
  } catch (cause) {
    return { state: 'ready', tools, outcome: { unserializable: messageOf(cause) } };
  }
}

/**
 * Asks the page, and refuses one that has no WebMCP. The page itself is
 * asked, because a browser the engine attaches to was launched elsewhere.
 */
async function ask(page: Page, label: string, call: PageCall | null): Promise<Extract<PageAnswer, { state: 'ready' }>> {
  const answer = await page.evaluate(askModelContext, call);
  if (answer.state === 'ready') return answer;
  if (answer.state === 'insecure') {
    throw new EngineError(
      'UNSUPPORTED_CAPABILITY',
      `${label}: this page has no WebMCP because it is not a secure context; serve it on https: or localhost`,
      { retryable: false },
    );
  }
  throw new EngineError(
    'UNSUPPORTED_CAPABILITY',
    `${label}: this browser runs without WebMCP; set web({ webmcp: true }), or start a browser the engine attaches to with ${WEBMCP_LAUNCH_ARG}`,
    { retryable: false },
  );
}

function missingTool(label: string, name: string, tools: readonly WebMcpTool[]): TestError {
  const available = tools.length === 0 ? 'The page registers no WebMCP tools.' : `Available tools: ${tools.map((tool) => tool.name).join(', ')}.`;
  return new TestError('ACTION_FAILED', `${label}: No WebMCP tool named ${JSON.stringify(name)}. ${available}`);
}

/**
 * A call that went to the page and ended with no answer from the tool,
 * because the tool sent the page elsewhere or the time ran out: whether the
 * tool ran is unknown, so the call must not be repeated blindly. Everything
 * else is left to the default translation.
 */
function translateUnanswered(cause: unknown, label: string, tool: string): Error {
  const unanswered = (text: string): EngineError => new EngineError('ACTION_MAY_HAVE_COMMITTED', `${label}: ${text}`, { retryable: false, cause });
  if (cause instanceof EngineError && cause.code === 'OPERATION_TIMEOUT') return unanswered(`the tool ${JSON.stringify(tool)} did not answer in time; it may have run`);
  if (!isClassified(cause) && isNavigationRace(cause)) return unanswered(`the page navigated before the tool ${JSON.stringify(tool)} answered; the tool may have run`);
  return translatePwError(cause, label);
}

/** A tool's result, read from the text the page gave for it: the JSON it holds, or the text itself. */
function resultOf(text: string): JsonValue {
  // A tool that resolves with nothing has no JSON form; `null` is the one JSON value that says so.
  if (text === 'undefined') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed as JsonValue;
  } catch {
    return text;
  }
}

/** Creates `browser.webmcp` for the active tab of `surface`. */
export function createWebMcp(surface: PlaywrightSurface, context: EngineFixtureContext): WebMcp {
  return {
    async tools() {
      const label = 'browser.webmcp.tools';
      const answer = await surface.guard(context.operation(), label, () => ask(surface.requirePage(), label, null));
      return answer.tools;
    },
    async callTool(name, input) {
      const label = 'browser.webmcp.callTool';
      if (typeof name !== 'string' || name === '') {
        throw new TestError('INVALID_ARGUMENT', `${label}: name must be a non-empty string`);
      }
      validateJsonValue(input, `${label} input`);
      // The browsers refuse any other input before the tool runs, each in its own words.
      if (input !== undefined && input !== null && (typeof input !== 'object' || Array.isArray(input))) {
        throw new TestError('INVALID_ARGUMENT', `${label}: input must be an object, got ${Array.isArray(input) ? 'an array' : `a ${typeof input}`}`);
      }
      const call: PageCall = { name, input: input ?? {} };
      // Only a failure after the call went to the page can have run the tool; one before it is a plain failure.
      let called = false;
      const answer = await surface.guard(
        context.operation(),
        label,
        async (operation) => {
          const page = surface.requirePage();
          const listed = await ask(page, label, null);
          if (!listed.tools.some((tool) => tool.name === name)) throw missingTool(label, name, listed.tools);
          // The listing can resolve after the deadline abandoned this call; a tool must not run with nobody waiting.
          operation.signal.throwIfAborted();
          called = true;
          // A tool may send the page elsewhere; that document loads before the call fails, so the next step does not race it.
          return surface.throughNavigation(page, operation, () => ask(page, label, call));
        },
        (cause, operationLabel) => (called ? translateUnanswered(cause, operationLabel, name) : translatePwError(cause, operationLabel)),
      );
      // The page dropped the tool between the listing and the call.
      if (answer.outcome === undefined) throw missingTool(label, name, answer.tools);
      if ('threw' in answer.outcome) throw new TestError('ACTION_FAILED', `${label}: the tool ${JSON.stringify(name)} failed: ${answer.outcome.threw}`);
      if ('unserializable' in answer.outcome) {
        throw new TestError('ACTION_FAILED', `${label}: the tool ${JSON.stringify(name)} ran, and its result has no JSON form: ${answer.outcome.unserializable}`);
      }
      return resultOf(answer.outcome.text);
    },
  };
}
