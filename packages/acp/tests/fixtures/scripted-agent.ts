/**
 * A scripted ACP agent on stdio, for tests. `ACP_SCRIPT` is a JSON array
 * with one entry per prompt turn, or an object keyed by text the prompt
 * contains, each a list of moves: call one of the client's MCP tools or several at once,
 * ask permission for a tool of the agent's own, run one
 * without asking, say something, fail the turn with a message in the error's
 * data, or hang until cancelled or for good. Every prompt and tool result is appended to `ACP_LOG` as JSON
 * lines, with the tool list the session saw, the names of the `E2E_`
 * variables it started with, the fields of `CODEX_CONFIG` the tests read,
 * a hash of `DEFAULT_AUTH_REQUEST`, and whether each Codex sign-in variable
 * is unset, empty, or set, and whether `NODE_DEBUG` is: never a credential. `ACP_USAGE` is the usage
 * each turn reports. With `ACP_HANG_INIT` set, the agent never answers
 * `initialize`; with `ACP_AUTH_REQUIRED=1` it refuses `session/new` as
 * not signed in, and with `ACP_PROMPT_AUTH_REQUIRED=1` every prompt.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type McpServer,
  type RequestPermissionResponse,
  type Usage,
} from '@agentclientprotocol/sdk/unstable';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Move =
  /** `on` picks the target id: the newest screen line that contains it. */
  | { readonly call: string; readonly on?: string; readonly args?: Record<string, unknown> }
  /** Calls sent at once, the way an agent batches parallel tool calls. */
  | { readonly batch: readonly { readonly call: string; readonly args?: Record<string, unknown> }[] }
  /** `requestMeta` goes on the permission request only; `status` is reported for the call after the answer. */
  | {
      readonly own: string;
      readonly kind?: string;
      readonly rawInput?: Record<string, unknown>;
      readonly meta?: Record<string, unknown>;
      readonly requestMeta?: Record<string, unknown>;
      readonly status?: 'completed';
    }
  /** `in_progress` leaves the tool running for the rest of the turn. */
  | { readonly ran: string; readonly kind?: string; readonly status?: 'completed' | 'failed' | 'in_progress' }
  | { readonly say: string }
  | { readonly fail: string }
  /** `thenRan` runs a tool of the agent's own without asking once the turn is cancelled, before the turn ends. */
  | { readonly hang: true; readonly thenRan?: string }
  | { readonly ignoreCancel: true };

/** Moves per turn in order, or per step: the moves of the first key the prompt contains. */
const script = JSON.parse(process.env['ACP_SCRIPT'] ?? '[]') as Move[][] | Record<string, Move[]>;
const movesFor = (prompt: string, index: number): Move[] =>
  Array.isArray(script) ? (script[index] ?? []) : (Object.entries(script).find(([key]) => prompt.includes(key))?.[1] ?? []);
const log = (entry: unknown) => {
  if (process.env['ACP_LOG'] === undefined) return;
  try {
    appendFileSync(process.env['ACP_LOG'], `${JSON.stringify(entry)}\n`);
  } catch {
    // The test removed its log directory; the agent may still be stopping.
  }
};

/** The Codex adapter's auth methods: any other `methodId` is logged as `other`, since it could be anything. */
const KNOWN_METHODS = new Set(['api-key', 'chat-gpt', 'chat-gpt-device-code', 'gateway']);

/**
 * The `DEFAULT_AUTH_REQUEST` the agent got, as the method it names and a
 * SHA-256 of the whole request, never the request: it may carry a key.
 * Unset or empty is none, as the Codex adapter reads it; anything it could
 * not parse, spaces included, is `unreadable`.
 */
function authRequest(request: string | undefined): { methodId: unknown; sha256: string } | 'unreadable' | null {
  if (request === undefined || request === '') return null;
  try {
    const { methodId } = JSON.parse(request) as { methodId?: unknown };
    return { methodId: typeof methodId === 'string' && KNOWN_METHODS.has(methodId) ? methodId : 'other', sha256: createHash('sha256').update(request).digest('hex') };
  } catch {
    return 'unreadable';
  }
}

/** Whether each variable Codex signs in from is unset, empty, or set: never a value. */
function authEnv(): Record<string, 'unset' | 'empty' | 'set'> {
  const names = ['CODEX_API_KEY', 'OPENAI_API_KEY', 'DEFAULT_AUTH_REQUEST', 'APP_SERVER_LOGS'];
  return Object.fromEntries(names.map((name) => [name, process.env[name] === undefined ? 'unset' : process.env[name] === '' ? 'empty' : 'set']));
}

/** Whether the agent started with `NODE_DEBUG`, which makes Node print each child's environment: never its value. */
function nodeDebug(): 'unset' | 'set' {
  return process.env['NODE_DEBUG'] === undefined ? 'unset' : 'set';
}

/** The MCP server names the stand-in `codex` lists, and the Codex features the preset switches: other names are hashed, never logged. */
const KNOWN_SERVERS = new Set(['playwright', 'executor', 'other', 'debug']);
const KNOWN_FEATURES = new Set([
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'goals', 'image_generation', 'multi_agent', 'multi_agent_v2',
  'plugins', 'shell_snapshot', 'shell_snapshot_v2', 'shell_tool', 'skill_search', 'tool_suggest', 'unified_exec', 'view_image',
]);

/** `name` when it is one of `known`, else a short hash of it, so a config cannot put arbitrary text in the log. */
function loggedName(name: string, known: ReadonlySet<string>): string {
  return known.has(name) ? name : `other-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`;
}

/** The parts of `CODEX_CONFIG` the tests read, so nothing else in it, such as a header, reaches the log. */
function codexConfig(config: string | undefined): string | null {
  if (config === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(config);
    if (typeof parsed !== 'object' || parsed === null) return 'unreadable';
    const { web_search, features, mcp_servers } = parsed as Record<string, unknown>;
    // Server names and their switch only: a server's own fields, such as headers, can carry a credential.
    const servers =
      typeof mcp_servers === 'object' && mcp_servers !== null
        ? Object.fromEntries(
            Object.entries(mcp_servers).map(([name, server]) => {
              const enabled = (server as { enabled?: unknown } | null)?.enabled;
              return [loggedName(name, KNOWN_SERVERS), { enabled: typeof enabled === 'boolean' ? enabled : 'other' }];
            }),
          )
        : 'other';
    const flags =
      typeof features === 'object' && features !== null
        ? Object.fromEntries(Object.entries(features).map(([name, on]) => [loggedName(name, KNOWN_FEATURES), typeof on === 'boolean' ? on : 'other']))
        : null;
    return JSON.stringify({ web_search: web_search === 'disabled' || web_search === 'cached' || web_search === 'live' ? web_search : 'other', features: flags, mcp_servers: servers });
  } catch {
    return 'unreadable';
  }
}

log({ pid: process.pid });

// With `ACP_STARTUP_STDERR` set, the agent writes it to stderr and exits 3 before it answers anything: a start that fails quoting a value.
// A short-lived child holds stdout open, so the client sees the exit, with its stderr, before the connection closes.
if (process.env['ACP_STARTUP_STDERR'] !== undefined) {
  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['ignore', 'inherit', 'ignore'], detached: true }).unref();
  // Latin-1 lets a fixture supply individual bytes, including half of a UTF-8 character.
  const encoding = process.env['ACP_STDERR_BYTES'] === '1' ? 'latin1' : 'utf8';
  await new Promise((resolve) => process.stderr.write(process.env['ACP_STARTUP_STDERR']!, encoding, resolve));
  const rest = process.env['ACP_STARTUP_STDERR_REST'];
  if (rest !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => process.stderr.write(rest, encoding, resolve));
  }
  process.exit(3);
}
log({ env: Object.keys(process.env).filter((name) => name.toUpperCase().startsWith('E2E_')).toSorted(), codexConfig: codexConfig(process.env['CODEX_CONFIG']), defaultAuthRequest: authRequest(process.env['DEFAULT_AUTH_REQUEST']), authEnv: authEnv(), nodeDebug: nodeDebug() });

/**
 * `ACP_EXIT_DELAY_MS` holds the agent in place after SIGTERM, so a test can
 * watch the session directory while the child is still alive. Teardown closes
 * stdin and the stdout pipe around the signal, and either can end a plain
 * process first: stdin's EOF can empty the event loop before the signal
 * handler runs, and a late write can hit EPIPE. Such an agent holds on through
 * both once it is stopping, and logs any error, so a test that sees it gone
 * early can say why; an error before that still ends it at once. The
 * delay starts at SIGTERM or stdin's end, whichever comes first, so an agent
 * whose test worker died without a teardown still exits.
 */
const exitDelayMs = Number(process.env['ACP_EXIT_DELAY_MS'] ?? '0');
if (exitDelayMs > 0) {
  const hold = setInterval(() => undefined, 60_000);
  let stopping = false;
  const stop = (reason: string) => {
    log({ stopping: reason, at: Date.now() });
    if (stopping) return;
    stopping = true;
    setTimeout(() => {
      clearInterval(hold);
      process.exit(0);
    }, exitDelayMs);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.stdin.on('end', () => stop('stdin end'));
  // Once stopping, an error is teardown's doing and the agent holds on; before that it is a real failure and exits at once.
  const failed = (kind: string) => (error: unknown) => {
    log({ [kind]: String(error), stopping });
    if (!stopping) process.exit(1);
  };
  process.stdout.on('error', failed('stdoutError'));
  process.on('uncaughtException', failed('uncaught'));
  process.on('unhandledRejection', failed('unhandled'));
  process.on('exit', (code) => log({ exit: code, at: Date.now() }));
}

let mcp: Client | undefined;
/** The screen lines the agent read this turn, newest first: each tool result's changes, then the prompt's screen. */
let screen = '';
let turn = 0;
let cancelRequested = false;
let cancelled: (() => void) | undefined;

agent()
  .onRequest(methods.agent.initialize, () =>
    process.env['ACP_HANG_INIT'] === undefined
      ? {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
          agentInfo: { name: 'scripted-agent', version: '1' },
          authMethods: [],
        }
      : new Promise<never>(() => undefined),
  )
  .onRequest(methods.agent.session.new, async ({ params }) => {
    if (process.env['ACP_AUTH_REQUIRED'] === '1') throw new RequestError(-32000, 'Authentication required');
    const server = params.mcpServers[0] as Extract<McpServer, { type: 'http' }>;
    mcp = new Client({ name: 'scripted-agent', version: '1' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)));
    const { tools } = await mcp.listTools();
    log({ session: { cwd: params.cwd, server: server.name, meta: params._meta ?? null, tools: tools.map((tool) => tool.name), readOnly: tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name) } });
    return {
      sessionId: 's1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'fast', name: 'Fast' },
            { value: 'slow', name: 'Slow' },
          ],
        },
      ],
      modes: {
        currentModeId: 'default',
        availableModes: [
          { id: 'default', name: 'Default' },
          { id: 'read-only', name: 'Read only' },
        ],
      },
    };
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    log({ mode: params.modeId });
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    log({ config: { [params.configId]: params.value } });
    return { configOptions: [] };
  })
  .onRequest(methods.agent.authenticate, () => ({}))
  .onRequest(methods.agent.session.close, () => {
    log({ closed: true });
    return {};
  })
  .onNotification(methods.agent.session.cancel, () => {
    log({ cancelled: true });
    cancelRequested = true;
    cancelled?.();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (process.env['ACP_PROMPT_AUTH_REQUIRED'] === '1') throw new RequestError(-32000, 'Authentication required');
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    log({ prompt: text });
    screen = text;
    cancelRequested = false;
    for (const move of movesFor(text, turn++)) {
      if ('say' in move) {
        await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: move.say } } });
      } else if ('fail' in move) {
        throw RequestError.internalError({ message: move.fail });
      } else if ('own' in move) {
        const toolCall = {
          toolCallId: `own-${turn}-${move.own}`,
          title: move.own,
          ...(move.kind === undefined ? {} : { kind: move.kind as 'execute' }),
          ...(move.rawInput === undefined ? {} : { rawInput: move.rawInput }),
          ...(move.meta === undefined ? {} : { _meta: move.meta }),
        };
        await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'tool_call', ...toolCall } });
        const answer: RequestPermissionResponse = await client.request(methods.client.session.requestPermission, {
          sessionId: 's1',
          toolCall,
          ...(move.requestMeta === undefined ? {} : { _meta: move.requestMeta }),
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        log({ permission: move.own, outcome: answer.outcome });
        if (move.status !== undefined) {
          await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: move.status } });
        }
      } else if ('ran' in move) {
        // A tool of the agent's own that runs without asking.
        const toolCallId = `ran-${turn}-${move.ran}`;
        await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId, title: move.ran, kind: (move.kind ?? 'read') as 'read', status: 'in_progress' } });
        if (move.status !== 'in_progress') {
          await client.notify(methods.client.session.update, { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId, status: move.status ?? 'completed' } });
        }
        log({ ran: move.ran });
      } else if ('batch' in move) {
        await Promise.all(
          move.batch.map(async ({ call, args }) => log({ call, result: await mcp!.callTool({ name: call, arguments: { ...args } }) })),
        );
      } else if ('ignoreCancel' in move) {
        await new Promise<never>(() => undefined);
      } else if ('hang' in move) {
        if (!cancelRequested) {
          await new Promise<void>((resolve) => {
            cancelled = resolve;
          });
        }
        if (move.thenRan !== undefined) {
          // Logged first: the executor stops this agent as soon as it reports the tool.
          log({ ran: move.thenRan });
          await client.notify(methods.client.session.update, {
            sessionId: 's1',
            update: { sessionUpdate: 'tool_call', toolCallId: `ran-${turn}-${move.thenRan}`, title: move.thenRan, kind: 'read', status: 'in_progress' },
          });
        }
        return { stopReason: 'cancelled' };
      } else {
        const id = move.on === undefined ? undefined : idOf(move.on);
        const result = await mcp!.callTool({ name: move.call, arguments: { ...move.args, ...(id === undefined ? {} : { target: id }) } });
        const content = (result.content as { type: string; text?: string }[] | undefined) ?? [];
        if (result.isError !== true) screen = `${content.map((part) => part.text ?? '').join('\n')}\n${screen}`;
        log({ call: move.call, result });
      }
    }
    await client.notify(methods.client.session.update, {
      sessionId: 's1',
      update: { sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.01 * turn, currency: 'USD' } },
    });
    return { stopReason: 'end_turn', usage: JSON.parse(process.env['ACP_USAGE'] ?? '{"totalTokens":15,"inputTokens":10,"outputTokens":5,"cachedReadTokens":4}') as Usage };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

function idOf(on: string): string | undefined {
  const line = screen.split('\n').find((entry) => entry.includes(on));
  return line?.match(/#(\S+)/)?.[1];
}
