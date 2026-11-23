/**
 * How to start each agent with e2e's step tools as its only tools. ACP lets
 * a client add tools but not take the agent's own away, so each preset turns
 * them off the way its agent allows. The adapter runs from the install found
 * from the working directory up, never fetched by name at run time.
 */

import { execFile } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { promisify } from 'node:util';
import { registerProviderKey } from 'e2e/agent';
import { ConfigurationError } from 'e2e/engine';
import { z } from 'zod';
import { agentEnvironment, type AgentLaunch } from './session.ts';
import type { AcpAgentOptions } from './types.ts';

const execFileAsync = promisify(execFile);

/** What `codex mcp list --json` prints, as far as the preset reads it. */
const CodexServerList = z.array(z.object({ name: z.string() }));

/** The `bin` field of a package manifest. */
const PackageBin = z.object({ bin: z.union([z.string(), z.record(z.string(), z.string())]).optional() });

/** The credential Codex ACP reads from an explicit API-key auth request. */
const CodexApiKeyRequest = z.object({
  methodId: z.literal('api-key'),
  _meta: z.object({ 'api-key': z.object({ apiKey: z.string() }) }),
});

function registerCodexRequestKey(request: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(request);
  } catch {
    // The adapter owns validation and gets the original text.
    return;
  }
  const parsed = CodexApiKeyRequest.safeParse(decoded);
  if (parsed.success) registerProviderKey('codex.api-key', parsed.data['_meta']['api-key'].apiKey);
}

/** Claude Code with no built-in tools, no user or project settings or MCP servers, and no saved session. */
export function claudeCodeLaunch(options: AcpAgentOptions): () => Promise<AgentLaunch> {
  const bin = adapterBin('@agentclientprotocol/claude-agent-acp', 'claude-agent-acp');
  const launch: AgentLaunch = {
    command: process.execPath,
    args: [bin],
    // The adapter starts on ANTHROPIC_MODEL ahead of the user's own settings, whose model may not start outside their CLI.
    env: { ...(options.model === undefined ? {} : { ANTHROPIC_MODEL: options.model }), ...options.env },
    model: options.model,
    sessionMeta: {
      claudeCode: {
        options: {
          tools: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: false,
          allowDangerouslySkipPermissions: false,
        },
      },
    },
    signIn: 'run `claude` and log in, or set ANTHROPIC_API_KEY',
  };
  return async () => launch;
}

/**
 * Codex in its read-only mode with no shell, web search, apps, plugins,
 * browser or computer use, and the user's own MCP servers turned off by
 * name, as `codex mcp list` reports them. The adapter merges this over the
 * user's Codex config for its sessions only. Codex may still start a
 * subagent, which fails the step like any tool of its own.
 */
export function codexLaunch(options: AcpAgentOptions): () => Promise<AgentLaunch> {
  const pkg = adapterPackage('@agentclientprotocol/codex-acp');
  const bin = binOf(pkg, 'codex-acp');
  let servers: Promise<string[]> | undefined;
  return async () => {
    servers ??= codexServers(pkg, options.env);
    servers.catch(() => {
      servers = undefined;
    });
    const config = JSON.stringify(codexConfig(await servers));
    // Read at each session, so a request or key set after the first one counts, and pinned for it.
    const auth = codexAuth(options.env);
    return {
      command: process.execPath,
      args: [bin],
      env: { ...options.env, ...auth.env, CODEX_CONFIG: config },
      model: options.model,
      mode: 'read-only',
      signIn: auth.signIn,
      loginRefused: auth.loginRefused,
    };
  };
}

/**
 * How one Codex session signs in: the variables it starts with, the hint
 * for a session it refuses, and the hint for a turn refused because the
 * saved login no longer works, which Codex keeps until logout.
 */
interface CodexAuth {
  readonly env: Record<string, string>;
  readonly signIn: string;
  readonly loginRefused: string;
}

/**
 * Signs Codex in with an OpenAI API key when one is set, in `env` or the
 * runner's environment, and no `DEFAULT_AUTH_REQUEST` is. The adapter
 * takes the first nonblank of `CODEX_API_KEY` and `OPENAI_API_KEY`, but
 * logs in with it only when the client asks; `DEFAULT_AUTH_REQUEST` asks
 * whenever Codex has no login of its own. Codex then stores the key as
 * its login, as `codex login --with-api-key` does. The request names the
 * method only.
 *
 * The adapter's log, which `APP_SERVER_LOGS` turns on, records the
 * request at startup and the login call it makes, key included, in plain
 * text. So with that log on the adapter gets no request at all, the
 * user's own included: a saved login still works, and a session Codex
 * refuses says why. A variable in `env` replaces the runner's, blank
 * included, so a config can keep a key from Codex; a blank request or key
 * then counts as none, and none reaches the adapter empty, since the
 * adapter parses a request of spaces and exits. Every variable the decision read is pinned,
 * an unset one as empty, which the adapter reads the same way, so the
 * agent starts on what was decided even if the environment changes
 * before it spawns.
 */
function codexAuth(env: Readonly<Record<string, string>> | undefined): CodexAuth {
  const value = (name: string) => (env !== undefined && Object.hasOwn(env, name) ? env[name] : process.env[name]) ?? '';
  const nonblank = (name: string) => (value(name).trim() === '' ? '' : value(name));
  const pinned = {
    CODEX_API_KEY: nonblank('CODEX_API_KEY'),
    OPENAI_API_KEY: nonblank('OPENAI_API_KEY'),
    DEFAULT_AUTH_REQUEST: nonblank('DEFAULT_AUTH_REQUEST'),
    APP_SERVER_LOGS: value('APP_SERVER_LOGS'),
  };
  const logged = pinned['APP_SERVER_LOGS'] !== '';
  const request = pinned['DEFAULT_AUTH_REQUEST'] !== '';
  const keyName = pinned['CODEX_API_KEY'] === '' ? 'OPENAI_API_KEY' : 'CODEX_API_KEY';
  const signIn = `run \`codex login\`, or set ${keyName}`;
  const freshAction = request ? 'fix DEFAULT_AUTH_REQUEST' : `set a working ${keyName}`;
  const withLoggingDisabled = `unset APP_SERVER_LOGS and ${freshAction}`;
  const fresh = logged ? `\`codex login\`, or ${withLoggingDisabled}` : `\`codex login\`${request ? ',' : ''} or ${freshAction}`;
  const loginRefused = `the model provider refused Codex's credentials. If Codex signed in with a saved login or key, run \`codex logout\` first, then ${fresh}. If they come from a custom model provider's key, fix that key`;
  const withoutRequest = { ...pinned, DEFAULT_AUTH_REQUEST: '' };
  const key = pinned['CODEX_API_KEY'] !== '' || pinned['OPENAI_API_KEY'] !== '';
  // The adapter logs whenever the variable is not empty, spaces included.
  if (logged && (request || key)) {
    return {
      env: withoutRequest,
      loginRefused,
      signIn: 'APP_SERVER_LOGS is set, and the Codex adapter would write sign-in credentials to its log in plain text, so e2e passes it no sign-in request: unset APP_SERVER_LOGS, or run `codex login`',
    };
  }
  if (request) {
    registerCodexRequestKey(pinned['DEFAULT_AUTH_REQUEST']);
    return { env: pinned, signIn: 'the DEFAULT_AUTH_REQUEST you set did not sign Codex in: fix or unset it, or run `codex login`', loginRefused };
  }
  if (!key) {
    return { env: withoutRequest, signIn: logged ? 'run `codex login`, or unset APP_SERVER_LOGS and set OPENAI_API_KEY' : signIn, loginRefused };
  }
  return { env: { ...pinned, DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key' }) }, signIn, loginRefused };
}

/** More than any `auth.json` holds: a login with its tokens is a few kilobytes. */
const MAX_SAVED_LOGIN_BYTES = 1_048_576;

/** What Codex keeps of a login in `auth.json`, as far as it is a credential. */
const CodexSavedLogin = z.object({
  OPENAI_API_KEY: z.string().nullish().catch(undefined),
  tokens: z
    .object({
      id_token: z.string().nullish().catch(undefined),
      access_token: z.string().nullish().catch(undefined),
      refresh_token: z.string().nullish().catch(undefined),
    })
    .nullish()
    .catch(undefined),
});

/**
 * Has the run redact the login Codex saved in `CODEX_HOME/auth.json`: a key
 * from an earlier `codex login --with-api-key`, which need not be the
 * environment's, or the tokens of a ChatGPT login. Codex signs in with it
 * ahead of any key, and a provider that quotes it back would otherwise put
 * it in the report. A login in the OS keyring cannot be read, and is not
 * redacted; nor is a file that is no login: not a regular file, or larger
 * than any login.
 */
export function registerSavedCodexLogin(env: Readonly<Record<string, string>> | undefined): void {
  // Where the agent will look, from the environment it starts with: its CODEX_HOME, an empty one being none, else `.codex` in its home.
  const given = (name: string) => env?.[name] ?? process.env[name];
  const home = given('CODEX_HOME') || join(given('HOME') || homedir(), '.codex');
  let saved: z.infer<typeof CodexSavedLogin>;
  try {
    // No file, or one that is no login, parses as nothing and is refused here like any other shape.
    saved = CodexSavedLogin.parse(JSON.parse(readBounded(join(home, 'auth.json')) ?? 'null'));
  } catch {
    // No saved login, or one this version cannot read.
    return;
  }
  for (const [name, value] of [
    ['codex.api-key', saved.OPENAI_API_KEY],
    ['codex.id-token', saved.tokens?.id_token],
    ['codex.access-token', saved.tokens?.access_token],
    ['codex.refresh-token', saved.tokens?.refresh_token],
  ] as const) {
    registerProviderKey(name, value);
  }
}

/**
 * The text of a regular file of at most `MAX_SAVED_LOGIN_BYTES`, checked and
 * read through one open file, so what is read is what was checked. Opened
 * without waiting: a pipe in the file's place has no writer to wait for.
 * `undefined` for a file that is neither; throws where there is none.
 */
function readBounded(file: string): string | undefined {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    const { size } = stats;
    if (!stats.isFile() || size > MAX_SAVED_LOGIN_BYTES) return undefined;
    const bytes = Buffer.alloc(size);
    return bytes.subarray(0, readSync(descriptor, bytes, 0, size, 0)).toString();
  } finally {
    closeSync(descriptor);
  }
}

/** The Codex features that give the agent a tool of its own, and shell snapshots, which copy the shell's environment, keys included, to disk. */
const CODEX_FEATURES_OFF = [
  'apps',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'goals',
  'image_generation',
  'multi_agent',
  'multi_agent_v2',
  'plugins',
  'shell_snapshot',
  'shell_snapshot_v2',
  'shell_tool',
  'skill_search',
  'tool_suggest',
  'unified_exec',
  'view_image',
];

function codexConfig(servers: readonly string[]): Record<string, unknown> {
  return {
    web_search: 'disabled',
    features: Object.fromEntries(CODEX_FEATURES_OFF.map((feature) => [feature, false])),
    mcp_servers: Object.fromEntries(servers.map((name) => [name, { enabled: false }])),
  };
}

/** The MCP servers the user's Codex config declares, from the Codex the adapter runs. */
async function codexServers(adapter: string, env: Readonly<Record<string, string>> | undefined): Promise<string[]> {
  const codexPath = env?.['CODEX_PATH'] ?? process.env['CODEX_PATH'];
  const [command, args] =
    codexPath === undefined
      ? [process.execPath, [createRequire(join(adapter, 'package.json')).resolve('@openai/codex/bin/codex.js')]]
      : [codexPath, []];
  try {
    const { stdout } = await execFileAsync(command, [...args, 'mcp', 'list', '--json'], {
      env: agentEnvironment({ ...process.env, ...env }),
      timeout: 30_000,
    });
    return CodexServerList.parse(JSON.parse(stdout)).map((server) => server.name);
  } catch (error) {
    throw new Error(`could not list your Codex MCP servers to turn them off: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * The directory of an adapter package installed in the project, found the
 * way Node finds a dependency, with links resolved: pnpm links a package
 * into the project, and its own dependencies resolve only from where it is.
 */
function adapterPackage(name: string): string {
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (directory === parse(directory).root) break;
  }
  throw new ConfigurationError(
    'INVALID_CONFIG',
    `${name} is not installed in ${process.cwd()} or a directory above it: npm install -D ${name}, and run e2e from that project`,
  );
}

function adapterBin(name: string, bin: string): string {
  return binOf(adapterPackage(name), bin);
}

function binOf(pkg: string, bin: string): string {
  const manifest = PackageBin.safeParse(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')));
  const declared = manifest.success ? manifest.data.bin : undefined;
  const path = typeof declared === 'string' ? declared : declared?.[bin];
  if (path === undefined) throw new ConfigurationError('INVALID_CONFIG', `${pkg} has no ${bin} command`);
  return join(pkg, path);
}
