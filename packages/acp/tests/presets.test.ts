import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StepExecutor, StepExecutorContext } from 'e2e';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets, registerProviderKey } from 'e2e/agent';
import { acp, claudeCode, codex } from '../src/index.ts';
import { codexLaunch } from '../src/presets.ts';

const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
const pass = { call: 'complete_step', args: { status: 'passed', summary: 'done' } };
const cleanups: (() => void)[] = [];
// No test reads the developer's own Codex login: a test that wants one names its own home.
beforeEach(() => {
  vi.stubEnv('CODEX_HOME', join(tmpdir(), 'e2e-acp-no-codex-home'));
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllEnvs();
});

/** A project with the scripted agent installed under an adapter's package name. */
function project(adapters: readonly string[] = []): string {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-acp-preset-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of adapters) {
    const pkg = join(directory, 'node_modules', name);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    const bin = name.split('/').at(-1)!;
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name, bin: { [bin]: 'dist/index.js' } }));
    writeFileSync(join(pkg, 'dist/index.js'), `import ${JSON.stringify(AGENT)};\n`);
  }
  return directory;
}

/** Builds the executor from inside `directory`, as a config loaded there does. */
function inProject<T>(directory: string, build: () => T): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return build();
  } finally {
    process.chdir(previous);
  }
}

/** Runs one passing step and returns what the agent logged. */
async function runStep(executor: StepExecutor, log: string): Promise<Record<string, unknown>[]> {
  await expect(executor.runStep(stepContext())).resolves.toMatchObject({ status: 'passed' });
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The messages of the error one step fails with, causes included, one per line. */
async function stepFailure(executor: StepExecutor): Promise<string> {
  const error = await executor.runStep(stepContext()).then(() => undefined, (rejection: unknown) => rejection);
  const messages: string[] = [];
  for (let cause = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
  return messages.join('\n');
}

/** The context of one act step on a fake web target. */
function stepContext(): StepExecutorContext {
  const attempt = new AbortController();
  cleanups.push(() => attempt.abort());
  const ctx = {
    step: { kind: 'act', index: 0, instruction: 'add a todo', params: undefined, secrets: [] },
    attempt: { testId: 't', attemptId: 'a', index: 0, signal: attempt.signal, memory: new Map() },
    signal: new AbortController().signal,
    target: { name: 'web', platform: 'web', verbs: new Set(['tap']) },
    ledger: '',
    agentContext: undefined,
    actions: {},
    observe: async () => ({ revision: '1', text: '#n1 button "Add"', truncated: false, viewport: { width: 800, height: 600 }, path: '/' }),
    attachTranscript: () => undefined,
    attachTurns: () => undefined,
    attachScreenshot: async () => 'screenshot',
    budgets: { maxActions: 5, maxModelCalls: 5, remainingMs: () => 60_000, actionsUsed: () => 0, recordModelCall: () => undefined, runTool: <T>(_: unknown, body: () => Promise<T>) => body() },
  } as unknown as StepExecutorContext;
  return ctx;
}

describe('agent presets', () => {
  it('refuses a preset whose adapter the project has not installed', () => {
    const directory = project();
    expect(() => inProject(directory, () => claudeCode())).toThrow(
      expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('npm install -D @agentclientprotocol/claude-agent-acp') }),
    );
    expect(() => inProject(directory, () => codex())).toThrow(/npm install -D @agentclientprotocol\/codex-acp/);
  });

  it("starts Claude Code's installed adapter with its own tools, settings, and saved sessions off", async () => {
    const directory = project(['@agentclientprotocol/claude-agent-acp']);
    const log = join(directory, 'agent.jsonl');
    const executor = inProject(directory, () =>
      claudeCode({ model: 'slow', env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
    );
    expect(executor.name).toBe('claude-code');
    const entries = await runStep(executor, log);
    const session = entries.find((entry) => 'session' in entry)?.['session'] as { meta: unknown };
    expect(session.meta).toEqual({
      claudeCode: {
        options: { tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, allowDangerouslySkipPermissions: false },
      },
    });
    expect(entries).toContainEqual({ config: { model: 'slow' } });
  });

  it("starts Codex read-only with its own tools and the user's MCP servers off", async () => {
    const directory = project(['@agentclientprotocol/codex-acp']);
    const log = join(directory, 'agent.jsonl');
    // Stands in for the Codex the adapter runs, which lists the user's MCP servers, and none when it gets a secret.
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, `#!/bin/sh\n[ "$1 $2 $3" = "mcp list --json" ] && [ -z "$E2E_SECRET_KEY" ] && echo '[{"name":"playwright"},{"name":"executor"}]'\n`);
    chmodSync(codexBin, 0o755);
    const executor = inProject(directory, () =>
      codex({ env: { CODEX_PATH: codexBin, E2E_SECRET_KEY: 'sk_test_value', ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }),
    );
    const entries = await runStep(executor, log);
    expect(entries).toContainEqual({ mode: 'read-only' });
    const config = JSON.parse(entries.find((entry) => 'codexConfig' in entry)?.['codexConfig'] as string) as {
      web_search: string;
      features: Record<string, boolean>;
      mcp_servers: Record<string, { enabled: boolean }>;
    };
    expect(config.web_search).toBe('disabled');
    const off = ['apps', 'browser_use', 'browser_use_external', 'computer_use', 'goals', 'image_generation', 'multi_agent', 'multi_agent_v2', 'plugins', 'shell_snapshot', 'shell_snapshot_v2', 'shell_tool', 'skill_search', 'tool_suggest', 'unified_exec', 'view_image'];
    expect(config.features).toEqual(Object.fromEntries(off.map((feature) => [feature, false])));
    expect(config.mcp_servers).toEqual({ playwright: { enabled: false }, executor: { enabled: false } });
  });

  /** A Codex executor on the scripted agent, with a stand-in `codex` that lists no MCP servers, and the log it writes. */
  function codexProject(env: Record<string, string> = {}): { executor: StepExecutor; log: string } {
    const directory = project(['@agentclientprotocol/codex-acp']);
    const log = join(directory, 'agent.jsonl');
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, `#!/bin/sh\necho '[]'\n`);
    chmodSync(codexBin, 0o755);
    const executor = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, ACP_SCRIPT: JSON.stringify([[pass], [pass]]), ACP_LOG: log, ...env } }));
    return { executor, log };
  }

  /** What the fixture logs of the `DEFAULT_AUTH_REQUEST` each Codex session started with, in order. */
  function authRequests(entries: readonly Record<string, unknown>[]): unknown[] {
    return entries.filter((entry) => 'defaultAuthRequest' in entry).map((entry) => entry['defaultAuthRequest']);
  }

  /** How the fixture logs `request`: its method and a SHA-256 of the exact text, so a test can compare without the fixture logging it. */
  function logged(request: string): { methodId: unknown; sha256: string } {
    return { methodId: (JSON.parse(request) as { methodId?: unknown }).methodId, sha256: createHash('sha256').update(request).digest('hex') };
  }

  /** The `DEFAULT_AUTH_REQUEST` one Codex step started with, as the fixture logs it, given the variables in `env`. */
  async function codexAuthRequest(env: Record<string, string>): Promise<unknown> {
    const { executor, log } = codexProject(env);
    return authRequests(await runStep(executor, log)).at(-1);
  }

  /** No key, auth request, or adapter log from the developer's shell. */
  function cleanAuthEnv(): void {
    for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'DEFAULT_AUTH_REQUEST', 'APP_SERVER_LOGS']) vi.stubEnv(name, undefined);
  }

  /** The request the preset sends: the method alone, never the key. */
  const API_KEY_LOGIN = logged('{"methodId":"api-key"}');

  it('registers the key from a custom Codex API-key request while preserving its exact text', async () => {
    cleanAuthEnv();
    const key = randomUUID();
    const request = JSON.stringify({ methodId: 'api-key', _meta: { 'api-key': { apiKey: key } } }, null, 2);
    vi.stubEnv('DEFAULT_AUTH_REQUEST', request);
    expect(await codexAuthRequest({})).toEqual(logged(request));
    expect(redactSecrets(key) === '<secret:codex.api-key>').toBe(true);
  });

  it('leaves validation of malformed authentication JSON to the Codex adapter', async () => {
    cleanAuthEnv();
    const { log } = codexProject();
    const directory = dirname(log);
    const request = '{';
    const launch = await inProject(directory, () => codexLaunch({ env: { CODEX_PATH: join(directory, 'codex'), DEFAULT_AUTH_REQUEST: request } }))();
    expect(launch.env?.['DEFAULT_AUTH_REQUEST']).toBe(request);
  });

  it('names the effective Codex sign-in setting after adapter logging is disabled', async () => {
    cleanAuthEnv();
    const { log } = codexProject();
    const directory = dirname(log);
    const env = { CODEX_PATH: join(directory, 'codex'), APP_SERVER_LOGS: '/tmp/codex-logs', CODEX_API_KEY: 'fixture-codex', OPENAI_API_KEY: 'fixture-openai' };
    const withKey = await inProject(directory, () => codexLaunch({ env }))();
    expect(withKey.loginRefused).toContain('unset APP_SERVER_LOGS and set a working CODEX_API_KEY');
    const withRequest = await inProject(directory, () => codexLaunch({ env: { ...env, DEFAULT_AUTH_REQUEST: '{"methodId":"chat-gpt"}' } }))();
    expect(withRequest.loginRefused).toContain('unset APP_SERVER_LOGS and fix DEFAULT_AUTH_REQUEST');
  });

  it('signs Codex in with an API key from its env or the process environment, sending the method alone', async () => {
    cleanAuthEnv();
    expect(await codexAuthRequest({ CODEX_API_KEY: 'sk-test-codex' })).toEqual(API_KEY_LOGIN);
    expect(await codexAuthRequest({ OPENAI_API_KEY: 'sk-test-openai' })).toEqual(API_KEY_LOGIN);
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    expect(await codexAuthRequest({})).toEqual(API_KEY_LOGIN);
  });

  it('leaves Codex to its own login without a key, and reads a blank auth request as none', async () => {
    cleanAuthEnv();
    expect(await codexAuthRequest({})).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', ' ');
    expect(await codexAuthRequest({ CODEX_API_KEY: '' })).toBeNull();
    // The adapter cannot parse a request of spaces and exits, so it gets none.
    vi.stubEnv('DEFAULT_AUTH_REQUEST', '   ');
    expect(await codexAuthRequest({})).toBeNull();
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: ' ' })).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    expect(await codexAuthRequest({})).toEqual(API_KEY_LOGIN);
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: '' })).toEqual(API_KEY_LOGIN);
  });

  it('passes an auth request from the config, else the environment, unchanged over a key', async () => {
    cleanAuthEnv();
    const fromConfig = '{"methodId":"api-key","_meta":{"api-key":{"apiKey":"sk-test-config-meta"}}}';
    const fromProcess = '{"methodId":"chat-gpt","_meta":{"source":"process"}}';
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    vi.stubEnv('DEFAULT_AUTH_REQUEST', fromProcess);
    expect(await codexAuthRequest({ CODEX_API_KEY: 'sk-test-codex', DEFAULT_AUTH_REQUEST: fromConfig })).toEqual(logged(fromConfig));
    expect(await codexAuthRequest({ CODEX_API_KEY: 'sk-test-codex' })).toEqual(logged(fromProcess));
    // The config's own values replace the environment's, blank ones too, so a config can keep a key or request from Codex.
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: '' })).toEqual(API_KEY_LOGIN);
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: '  ', OPENAI_API_KEY: '' })).toBeNull();
    vi.stubEnv('DEFAULT_AUTH_REQUEST', undefined);
    expect(await codexAuthRequest({ OPENAI_API_KEY: ' ' })).toBeNull();
  });

  it('reads the auth request again for each session of one executor', async () => {
    cleanAuthEnv();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    const { executor, log } = codexProject();
    await runStep(executor, log);
    const gateway = '{"methodId":"gateway"}';
    vi.stubEnv('DEFAULT_AUTH_REQUEST', gateway);
    expect(authRequests(await runStep(executor, log))).toEqual([API_KEY_LOGIN, logged(gateway)]);
  });

  it('passes Codex no sign-in request, its own or an explicit one, while the adapter log, which would record it, is on', async () => {
    cleanAuthEnv();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    vi.stubEnv('APP_SERVER_LOGS', '/tmp/codex-logs');
    expect(await codexAuthRequest({})).toBeNull();
    expect(await codexAuthRequest({ CODEX_API_KEY: 'sk-test-codex', APP_SERVER_LOGS: ' ' })).toBeNull();
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: '{"methodId":"api-key","_meta":{"api-key":{"apiKey":"sk-test-meta"}}}' })).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', undefined);
    expect(await codexAuthRequest({ DEFAULT_AUTH_REQUEST: '{"methodId":"gateway"}' })).toBeNull();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    const { executor } = codexProject({ ACP_AUTH_REQUIRED: '1' });
    expect(await stepFailure(executor)).toContain('so e2e passes it no sign-in request: unset APP_SERVER_LOGS, or run `codex login`');
    // The adapter keeps an empty one off, so the key signs in.
    expect(await codexAuthRequest({ APP_SERVER_LOGS: '' })).toEqual(API_KEY_LOGIN);
  });

  it('starts Codex with every sign-in variable pinned, unset ones empty', async () => {
    cleanAuthEnv();
    const authEnv = async (env: Record<string, string>) => {
      const { executor, log } = codexProject(env);
      return (await runStep(executor, log)).find((entry) => 'authEnv' in entry)?.['authEnv'];
    };
    expect(await authEnv({})).toEqual({ CODEX_API_KEY: 'empty', OPENAI_API_KEY: 'empty', DEFAULT_AUTH_REQUEST: 'empty', APP_SERVER_LOGS: 'empty' });
    expect(await authEnv({ CODEX_API_KEY: 'sk-test-codex' })).toEqual({ CODEX_API_KEY: 'set', OPENAI_API_KEY: 'empty', DEFAULT_AUTH_REQUEST: 'set', APP_SERVER_LOGS: 'empty' });
    expect(await authEnv({ OPENAI_API_KEY: 'sk-test-openai', APP_SERVER_LOGS: '/tmp/codex-logs' })).toEqual({ CODEX_API_KEY: 'empty', OPENAI_API_KEY: 'set', DEFAULT_AUTH_REQUEST: 'empty', APP_SERVER_LOGS: 'set' });
    expect(await authEnv({ DEFAULT_AUTH_REQUEST: '{"methodId":"chat-gpt"}' })).toEqual({ CODEX_API_KEY: 'empty', OPENAI_API_KEY: 'empty', DEFAULT_AUTH_REQUEST: 'set', APP_SERVER_LOGS: 'empty' });
  });

  it('keeps what one Codex launch decided when the environment changes before the agent starts', async () => {
    cleanAuthEnv();
    const { log } = codexProject();
    const directory = dirname(log);
    const request = '{"methodId":"chat-gpt"}';
    vi.stubEnv('DEFAULT_AUTH_REQUEST', request);
    const launch = await inProject(directory, () => codexLaunch({ env: { CODEX_PATH: join(directory, 'codex') } }))();
    vi.stubEnv('DEFAULT_AUTH_REQUEST', '{"methodId":"gateway"}');
    vi.stubEnv('APP_SERVER_LOGS', '/tmp/codex-logs');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-late');
    expect(launch.env).toMatchObject({ DEFAULT_AUTH_REQUEST: request, APP_SERVER_LOGS: '', OPENAI_API_KEY: '', CODEX_API_KEY: '' });
  });

  it('signs Codex in from the environment when the preset gets no env at all', async () => {
    cleanAuthEnv();
    const { log } = codexProject();
    const directory = dirname(log);
    vi.stubEnv('CODEX_PATH', join(directory, 'codex'));
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-process');
    vi.stubEnv('APP_SERVER_LOGS', '');
    const launch = await inProject(directory, () => codexLaunch({}))();
    expect(launch.env).toMatchObject({ DEFAULT_AUTH_REQUEST: '{"methodId":"api-key"}', APP_SERVER_LOGS: '' });
    vi.stubEnv('APP_SERVER_LOGS', '/tmp/codex-logs');
    expect((await inProject(directory, () => codexLaunch({}))()).env).toMatchObject({ DEFAULT_AUTH_REQUEST: '', APP_SERVER_LOGS: '/tmp/codex-logs' });
  });

  it('tells a Codex user whose saved login is refused at a prompt to log out, naming the key a new sign-in would use', async () => {
    cleanAuthEnv();
    const { executor } = codexProject({ ACP_PROMPT_AUTH_REQUIRED: '1' });
    const refused = await stepFailure(executor);
    expect(refused).toContain(
      "the agent's credentials were refused: the model provider refused Codex's credentials. If Codex signed in with a saved login or key, run `codex logout` first, then `codex login` or set a working OPENAI_API_KEY. If they come from a custom model provider's key, fix that key",
    );
    // The hint names what a fresh sign-in would use: CODEX_API_KEY first, the user's request, or nothing while the adapter log is on.
    expect(await stepFailure(codexProject({ ACP_PROMPT_AUTH_REQUIRED: '1', CODEX_API_KEY: 'sk-test-codex' }).executor)).toContain(
      'first, then `codex login` or set a working CODEX_API_KEY.',
    );
    expect(await stepFailure(codexProject({ ACP_PROMPT_AUTH_REQUIRED: '1', DEFAULT_AUTH_REQUEST: '{"methodId":"chat-gpt"}' }).executor)).toContain(
      'first, then `codex login`, or fix DEFAULT_AUTH_REQUEST.',
    );
    expect(await stepFailure(codexProject({ ACP_PROMPT_AUTH_REQUIRED: '1', APP_SERVER_LOGS: '/tmp/codex-logs' }).executor)).toContain(
      'first, then `codex login`, or unset APP_SERVER_LOGS and set a working OPENAI_API_KEY.',
    );
    expect(refused).toContain('Authentication required');
    // Any other failed turn keeps its own error.
    const directory = project(['@agentclientprotocol/codex-acp']);
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, `#!/bin/sh\necho '[]'\n`);
    chmodSync(codexBin, 0o755);
    const failing = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, ACP_SCRIPT: JSON.stringify([[{ fail: 'quota exceeded' }]]) } }));
    const other = await stepFailure(failing);
    expect(other).toContain('quota exceeded');
    expect(other).not.toContain('credentials were refused');
  });

  it('says the agent is not signed in, with its hint when it has one, and keeps the refusal as the cause', async () => {
    const claude = project(['@agentclientprotocol/claude-agent-acp']);
    const refused = await stepFailure(inProject(claude, () => claudeCode({ env: { ACP_AUTH_REQUIRED: '1' } })));
    expect(refused).toContain('the agent is not signed in: run `claude` and log in, or set ANTHROPIC_API_KEY\nAuthentication required');
    const generic = await stepFailure(acp({ command: process.execPath, args: [AGENT], env: { ACP_AUTH_REQUIRED: '1' } }));
    expect(generic).toContain('the agent is not signed in\nAuthentication required');
  });

  it('keeps the plain refusal for an agent with no saved-login hint', async () => {
    const directory = project(['@agentclientprotocol/claude-agent-acp']);
    const executor = inProject(directory, () => claudeCode({ env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_PROMPT_AUTH_REQUIRED: '1' } }));
    const refused = await stepFailure(executor);
    expect(refused).toContain('Authentication required');
    expect(refused).not.toContain('credentials were refused');
  });

  it('lists the Codex MCP servers once for every session of one executor', async () => {
    const { executor, log } = codexProject();
    const codexBin = join(dirname(log), 'codex');
    writeFileSync(codexBin, `#!/bin/sh\necho x >> "$0.calls"\necho '[]'\n`);
    await runStep(executor, log);
    await runStep(executor, log);
    expect(readFileSync(`${codexBin}.calls`, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('lists the Codex MCP servers again after a failed listing', async () => {
    const { executor, log } = codexProject();
    const codexBin = join(dirname(log), 'codex');
    // Fails the first listing only, as a Codex that cannot start yet would.
    writeFileSync(codexBin, `#!/bin/sh\n[ -f "$0.ran" ] && echo '[]' && exit 0\ntouch "$0.ran"\nexit 1\n`);
    expect(await stepFailure(executor)).toContain('could not list your Codex MCP servers');
    expect(authRequests(await runStep(executor, log))).toHaveLength(1);
  });

  it('tells a Codex user who is not signed in to log in or set OPENAI_API_KEY', async () => {
    cleanAuthEnv();
    const { executor } = codexProject({ ACP_AUTH_REQUIRED: '1' });
    expect(await stepFailure(executor)).toContain('the agent is not signed in: run `codex login`, or set OPENAI_API_KEY');
    const withBothKeys = await stepFailure(codexProject({ ACP_AUTH_REQUIRED: '1', CODEX_API_KEY: 'fixture-codex', OPENAI_API_KEY: 'fixture-openai' }).executor);
    expect(withBothKeys).toContain('the agent is not signed in: run `codex login`, or set CODEX_API_KEY');
    const withRequest = await stepFailure(codexProject({ ACP_AUTH_REQUIRED: '1', OPENAI_API_KEY: 'sk-test-codex', DEFAULT_AUTH_REQUEST: '{}' }).executor);
    expect(withRequest).toContain('the DEFAULT_AUTH_REQUEST you set did not sign Codex in');
    // With the log on, a key would not be used, so the hint says to turn the log off first.
    vi.stubEnv('APP_SERVER_LOGS', '/tmp/codex-logs');
    const withLogOn = await stepFailure(codexProject({ ACP_AUTH_REQUIRED: '1' }).executor);
    expect(withLogOn).toContain('the agent is not signed in: run `codex login`, or unset APP_SERVER_LOGS and set OPENAI_API_KEY');
  });
});

describe('the environment an agent starts with', () => {
  /** What the agent of one step logged at startup, `env` its config's variables. */
  async function startup(env: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const log = join(mkdtempSync(join(tmpdir(), 'e2e-acp-env-')), 'agent.jsonl');
    cleanups.push(() => rmSync(dirname(log), { recursive: true, force: true }));
    const executor = acp({ command: process.execPath, args: [AGENT], env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log, ...env } });
    const entries = await runStep(executor, log);
    const first = entries.find((entry) => 'nodeDebug' in entry);
    expect(first).toBeDefined();
    return first!;
  }

  it('starts the agent without NODE_DEBUG, which would make Node print every environment the agent hands its children', async () => {
    vi.stubEnv('NODE_DEBUG', 'child_process');
    expect((await startup())['nodeDebug']).toBe('unset');
  });

  it('drops NODE_DEBUG from the config too, and keeps the other variables', async () => {
    vi.stubEnv('NODE_DEBUG', undefined);
    const entry = await startup({ NODE_DEBUG: 'net,child_process', E2E_PROBE_KEPT: 'kept' });
    expect(entry['nodeDebug']).toBe('unset');
    expect(entry['env']).toContain('E2E_PROBE_KEPT');
  });

  it('starts the agent as before without NODE_DEBUG anywhere', async () => {
    vi.stubEnv('NODE_DEBUG', undefined);
    expect((await startup())['nodeDebug']).toBe('unset');
  });
});

describe('a key only the agent is given', () => {
  it("is redacted from the moment the executor is built, before a step's text exists", () => {
    const key = 'sk-test-agent-env-only-5a9c2e7f1b';
    vi.stubEnv('OPENAI_API_KEY', undefined);
    expect(redactSecrets(key)).toBe(key);
    acp({ command: process.execPath, args: [AGENT], env: { OPENAI_API_KEY: key } });
    expect(redactSecrets(key)).toBe('<secret:OPENAI_API_KEY>');
  });

  it('reaches the agent as its marker in the system text', async () => {
    const key = 'sk-test-agent-system-8c3f1a6d2e9b';
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const log = join(mkdtempSync(join(tmpdir(), 'e2e-acp-system-')), 'agent.jsonl');
    cleanups.push(() => rmSync(dirname(log), { recursive: true, force: true }));
    const executor = acp({ command: process.execPath, args: [AGENT], system: `Sign in with ${key} when asked.`, env: { OPENAI_API_KEY: key, ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } });
    await expect(executor.runStep(stepContext())).resolves.toMatchObject({ status: 'passed' });
    const prompt = String(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => 'prompt' in entry)?.['prompt']);
    expect(prompt).toContain('Sign in with <secret:OPENAI_API_KEY> when asked.');
    expect(prompt).not.toContain(key.slice(-12));
  });

  it('reaches the agent as its marker when it became known only after the executor was built', async () => {
    const key = 'sk-test-agent-late-3f8b1d6a9e2c';
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const log = join(mkdtempSync(join(tmpdir(), 'e2e-acp-late-')), 'agent.jsonl');
    cleanups.push(() => rmSync(dirname(log), { recursive: true, force: true }));
    const executor = acp({ command: process.execPath, args: [AGENT], system: `Sign in with ${key} when asked.`, env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } });
    // Set after the executor was built and core built the step: the agent's start registers it.
    vi.stubEnv('OPENAI_API_KEY', key);
    const ctx = stepContext();
    (ctx.step as { instruction: string }).instruction = `type ${key} into the key field`;
    await expect(executor.runStep(ctx)).resolves.toMatchObject({ status: 'passed' });
    const prompt = String(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => 'prompt' in entry)?.['prompt']);
    expect(prompt).toContain('Sign in with <secret:OPENAI_API_KEY> when asked.');
    expect(prompt).toContain('type <secret:OPENAI_API_KEY> into the key field');
    expect(prompt).not.toContain(key.slice(-12));
  });

  it('reaches the agent with a run secret in its system text as the marker the step\'s redactor gives', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'e2e-acp-secret-')), 'agent.jsonl');
    cleanups.push(() => rmSync(dirname(log), { recursive: true, force: true }));
    const executor = acp({ command: process.execPath, args: [AGENT], system: 'Log in with fake-app-password-0001 when asked.', env: { ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } });
    const ctx = stepContext();
    // The redactor core attaches to the context of each step it runs.
    Object.defineProperty(ctx, Symbol.for('e2e.executor-redactor.v1'), { value: (text: string) => text.replaceAll('fake-app-password-0001', '<secret:appPassword>') });
    await expect(executor.runStep(ctx)).resolves.toMatchObject({ status: 'passed' });
    const prompt = String(readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>).find((entry) => 'prompt' in entry)?.['prompt']);
    expect(prompt).toContain('Log in with <secret:appPassword> when asked.');
  });

  it('is redacted when it is the token Claude Code signs in with, which a failed start quotes', async () => {
    const token = 'sk-ant-oat01-test-claude-code-4d9a1f7c2e6b';
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', undefined);
    const directory = project(['@agentclientprotocol/claude-agent-acp']);
    const executor = inProject(directory, () => claudeCode({ env: { CLAUDE_CODE_OAUTH_TOKEN: token, ACP_STARTUP_STDERR: `fatal: invalid token ${token}\n` } }));
    const failure = await stepFailure(executor);
    expect(failure).toContain('the agent exited (code 3): fatal: invalid token <secret:CLAUDE_CODE_OAUTH_TOKEN>');
    expect(failure).not.toContain(token.slice(-12));
  });

  it('builds an executor with no env of its own', () => {
    expect(acp({ command: process.execPath, args: [AGENT] }).name).toBe('acp');
  });

  it('names a Codex executor codex, or as the config names it, and looks for its saved login with no env of its own', async () => {
    const directory = project(['@agentclientprotocol/codex-acp']);
    expect(inProject(directory, () => codex({ name: 'reviewer' })).name).toBe('reviewer');
    const executor = inProject(directory, () => codex());
    expect(executor.name).toBe('codex');
    // The stand-in adapter ships no Codex to list MCP servers with, so the step fails there, past the saved login.
    expect(await stepFailure(executor)).toContain('The ACP agent did not start: Cannot find module');
  });
});

describe('a key the agent repeats where its text is cut', () => {
  it('redacts a key longer than what is kept of a line, written to stderr in two pieces', async () => {
    const key = `eyJ-test-long-token-${'k7'.repeat(1500)}`;
    vi.stubEnv('VERCEL_OIDC_TOKEN', key);
    const half = Math.floor(key.length / 2);
    const failure = await stepFailure(acp({
      command: process.execPath,
      args: [AGENT],
      env: {
        ACP_STARTUP_STDERR: `an earlier line\nfatal: ${key.slice(0, half)}`,
        ACP_STARTUP_STDERR_REST: `${key.slice(half)} rejected\n`,
      },
    }));
    expect(failure).toContain('the agent exited (code 3): fatal: <secret:VERCEL_OIDC_TOKEN> rejected');
    expect(failure).not.toContain('earlier line');
    expect(failure).not.toContain('k7k7k7k7');
  });

  it('redacts a key in the reply of a turn with no verdict before cutting the reply short', async () => {
    const key = 'sk-test-reply-4be19c07a6d2f358';
    vi.stubEnv('OPENAI_API_KEY', key);
    // The key starts 10 characters before the cut at 300, so cutting first would keep its head.
    const reply = `first line\n${'x'.repeat(290)}${key} and more\n  `;
    const executor = acp({ command: process.execPath, args: [AGENT], env: { ACP_SCRIPT: JSON.stringify([[{ say: reply }]]) } });
    const verdict = await executor.runStep(stepContext());
    expect(verdict).toMatchObject({ status: 'failed', errorCode: 'STEP_NO_CONCLUSION' });
    expect(verdict.summary).toBe(`The agent ended its turn (end_turn) without complete_step: ${'x'.repeat(290)}<secret:OP`);
    expect(verdict.summary).not.toContain('sk-test-re');
  });

  it('redacts a key in what the agent wrote to stderr before keeping the end of it, when the agent exits', async () => {
    const key = 'sk-test-stderr-7c3a05e9d1b64f82';
    vi.stubEnv('OPENAI_API_KEY', key);
    // A child of the agent keeps its output open, so the exit is what the step hears of, not a closed connection.
    // The key starts 10 characters before the last 2000 of the line, so keeping the end first would keep its tail.
    const line = `fatal: ${key.slice(0, 10)}`.length;
    expect(line).toBe(17);
    const failure = await stepFailure(acp({
      command: process.execPath,
      args: [AGENT],
      env: { ACP_STARTUP_STDERR: `fatal: ${key}${'y'.repeat(2000 - (key.length - 10))}\n` },
    }));
    expect(failure).toContain('the agent exited (code 3): ');
    expect(failure).toContain(`OPENAI_API_KEY>${'y'.repeat(50)}`);
    expect(failure).not.toContain(key.slice(10));
    // Only the end of a long line is kept.
    expect(failure).not.toContain('fatal:');
  });

  it('decodes stderr as one UTF-8 stream when a character spans writes', async () => {
    const key = 'synthetic-token-café-test-value';
    vi.stubEnv('OPENAI_API_KEY', key);
    const bytes = Buffer.from(`fatal: ${key} rejected\n`);
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    const failure = await stepFailure(acp({
      command: process.execPath,
      args: [AGENT],
      env: {
        ACP_STDERR_BYTES: '1',
        ACP_STARTUP_STDERR: bytes.subarray(0, split).toString('latin1'),
        ACP_STARTUP_STDERR_REST: bytes.subarray(split).toString('latin1'),
      },
    }));
    expect(failure).toContain('fatal: <secret:OPENAI_API_KEY> rejected');
    expect(failure).not.toContain('synthetic-token-caf');
  });

  it('redacts a secret that spans lines before taking the last line of the reply', async () => {
    const key = `sk-test-two-line-key\nsecond-line-of-the-key-9d3f`;
    registerProviderKey('agent.two-line-key', key);
    const executor = acp({ command: process.execPath, args: [AGENT], env: { ACP_SCRIPT: JSON.stringify([[{ say: `the provider quoted ${key}` }]]) } });
    const verdict = await executor.runStep(stepContext());
    expect(verdict.summary).toBe('The agent ended its turn (end_turn) without complete_step: the provider quoted <secret:agent.two-line-key>');
  });

  it('says only that the turn ended when the agent said nothing', async () => {
    const executor = acp({ command: process.execPath, args: [AGENT], env: { ACP_SCRIPT: JSON.stringify([[]]) } });
    expect((await executor.runStep(stepContext())).summary).toBe('The agent ended its turn (end_turn) without complete_step');
  });
});

describe('the login Codex saved', () => {
  const saved = {
    key: 'sk-saved-0f3a9c5e7b1d2468',
    id: 'id-token-5c1e8a3f7d9b0246',
    access: 'access-token-9d2b6f4a8c0e1357',
    refresh: 'refresh-token-3e7a1c9f5b8d0246',
  };

  /** A Codex home holding `auth`, and a Codex executor on the scripted agent whose config names `env`. */
  function codexWith(auth: string | undefined, env: (home: string) => Record<string, string>): { executor: StepExecutor; log: string } {
    const directory = project(['@agentclientprotocol/codex-acp']);
    const home = join(directory, 'home', '.codex');
    mkdirSync(home, { recursive: true });
    if (auth !== undefined) writeFileSync(join(home, 'auth.json'), auth);
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, "#!/bin/sh\necho '[]'\n");
    chmodSync(codexBin, 0o755);
    const log = join(directory, 'agent.jsonl');
    const executor = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log, ...env(home) } }));
    return { executor, log };
  }

  const login = (fields: Record<string, unknown>) => JSON.stringify({ auth_mode: 'apikey', ...fields });

  it('is redacted once a session starts: the key and each token, from the CODEX_HOME of the config', async () => {
    vi.stubEnv('CODEX_HOME', '/nonexistent/codex-home');
    const all = `${saved.key} ${saved.id} ${saved.access} ${saved.refresh}`;
    expect(redactSecrets(all)).toBe(all);
    const { executor, log } = codexWith(
      login({ OPENAI_API_KEY: saved.key, tokens: { id_token: saved.id, access_token: saved.access, refresh_token: saved.refresh, account_id: 'acct' } }),
      (home) => ({ CODEX_HOME: home }),
    );
    await runStep(executor, log);
    expect(redactSecrets(all)).toBe('<secret:codex.api-key> <secret:codex.id-token> <secret:codex.access-token> <secret:codex.refresh-token>');
  });

  // Core builds the first step's text with the ledger as it stands, so the login must be known before then.
  it('is known as soon as the executor is built, before any step', () => {
    const key = 'sk-saved-first-step-2d7b9e4a1c6f';
    expect(redactSecrets(key)).toBe(key);
    codexWith(login({ OPENAI_API_KEY: key }), (home) => ({ CODEX_HOME: home }));
    expect(redactSecrets(key)).toBe('<secret:codex.api-key>');
  });

  it('is redacted from the first start that fails quoting it, before the line is cut', async () => {
    // The last 2,000 characters of the line start inside the token: its last 30 characters are kept unless it was redacted first.
    const token = `access-token-${'4f9e2a7c'.repeat(6)}`;
    const { executor } = codexWith(login({ tokens: { access_token: token } }), (home) => ({ CODEX_HOME: home, ACP_STARTUP_STDERR: `fatal: ${token} rejected${'y'.repeat(1961)}\n` }));
    const failure = await stepFailure(executor);
    expect(failure).toContain('the agent exited (code 3)');
    expect(failure).toContain('<secret:codex.access-token> rejected');
    expect(failure).not.toContain(token.slice(-16));
    expect(failure).not.toContain('4f9e2a7c4f9e2a7c');
  });

  it('is read from the CODEX_HOME of the environment when the config names none', async () => {
    const key = 'sk-saved-env-home-6b2d8f0a4c1e';
    const { executor, log } = codexWith(login({ OPENAI_API_KEY: key }), () => ({}));
    vi.stubEnv('CODEX_HOME', join(dirname(log), 'home', '.codex'));
    await runStep(executor, log);
    expect(redactSecrets(key)).toBe('<secret:codex.api-key>');
  });

  it.each([['no CODEX_HOME is set', undefined], ['CODEX_HOME is empty', '']])('is read from ~/.codex when %s', async (_label, value) => {
    const key = `sk-saved-default-home-${value === undefined ? '1a7c3e9b5d' : '8f2b6d0c4e'}`;
    const { executor, log } = codexWith(login({ OPENAI_API_KEY: key }), () => ({}));
    vi.stubEnv('CODEX_HOME', value);
    vi.stubEnv('HOME', join(dirname(log), 'home'));
    vi.stubEnv('USERPROFILE', join(dirname(log), 'home'));
    await runStep(executor, log);
    expect(redactSecrets(key)).toBe('<secret:codex.api-key>');
  });

  it("is read from the home the config gives the agent, not the runner's", async () => {
    const agents = 'sk-saved-agent-home-2c8e4a6f0b1d';
    const runners = 'sk-saved-runner-home-7f3b9d5a1c0e';
    const { executor, log } = codexWith(login({ OPENAI_API_KEY: agents }), (home) => ({ HOME: dirname(home) }));
    const runnerHome = join(dirname(log), 'runner');
    mkdirSync(join(runnerHome, '.codex'), { recursive: true });
    writeFileSync(join(runnerHome, '.codex', 'auth.json'), login({ OPENAI_API_KEY: runners }));
    vi.stubEnv('CODEX_HOME', undefined);
    vi.stubEnv('HOME', runnerHome);
    await runStep(executor, log);
    expect(redactSecrets(`${agents} ${runners}`)).toBe(`<secret:codex.api-key> ${runners}`);
  });

  it('is read again when the agent fails to start, since signing in is when Codex writes one', async () => {
    const key = 'sk-saved-at-startup-6f0c3a9e2d7b';
    const directory = project(['@agentclientprotocol/codex-acp']);
    const home = join(directory, '.codex');
    mkdirSync(home);
    const codexBin = join(directory, 'codex');
    // Stands in for a Codex that saves a login while the session starts, after the step's first look.
    // The login is a file the script copies: its text never becomes part of the script.
    const loginToSave = join(directory, 'login-to-save.json');
    writeFileSync(loginToSave, login({ OPENAI_API_KEY: key }));
    writeFileSync(codexBin, '#!/bin/sh\ncat "$CODEX_LOGIN_TO_SAVE" > "$CODEX_HOME/auth.json"\necho \'[]\'\n');
    chmodSync(codexBin, 0o755);
    const executor = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, CODEX_HOME: home, CODEX_LOGIN_TO_SAVE: loginToSave, ACP_AUTH_REQUIRED: '1' } }));
    expect(redactSecrets(key)).toBe(key);
    expect(await stepFailure(executor)).toContain('the agent is not signed in');
    expect(redactSecrets(key)).toBe('<secret:codex.api-key>');
  });

  it('starts the session with a token in the login far longer than any token, and redacts the rest of it', async () => {
    const access = 'access-token-beside-huge-3b7e1d9a5c';
    const huge = `eyJ${'hugetoken'.repeat(2300)}`;
    const { executor, log } = codexWith(login({ tokens: { id_token: huge, access_token: access } }), (home) => ({ CODEX_HOME: home }));
    await runStep(executor, log);
    expect(redactSecrets(`${access} ${huge.slice(0, 40)}`)).toBe(`<secret:codex.access-token> ${huge.slice(0, 40)}`);
  });

  it('takes the fields it can read of a login in another shape, and starts the session', async () => {
    const access = 'access-token-partial-4f8b2d6a0c';
    const { executor, log } = codexWith(login({ OPENAI_API_KEY: null, tokens: { id_token: { raw: 'object-id-token-7e1c5a9d3b' }, access_token: access } }), (home) => ({ CODEX_HOME: home }));
    await runStep(executor, log);
    expect(redactSecrets(`${access} object-id-token-7e1c5a9d3b`)).toBe('<secret:codex.access-token> object-id-token-7e1c5a9d3b');
  });

  it.each([['no saved login', undefined], ['a login that is not JSON', '{not json'], ['a login with no tokens', '{"auth_mode":"chatgpt","tokens":null}']])('starts the session with %s', async (_label, auth) => {
    const { executor, log } = codexWith(auth, (home) => ({ CODEX_HOME: home }));
    await runStep(executor, log);
  });

  it('starts the session, and reads nothing, when auth.json is no file', async () => {
    const { executor, log } = codexWith(undefined, (home) => ({ CODEX_HOME: home }));
    mkdirSync(join(dirname(log), 'home', '.codex', 'auth.json'));
    await runStep(executor, log);
  });

  it('reads a login of exactly the largest size it takes, and nothing larger', async () => {
    const fits = 'sk-saved-largest-login-4d0a7e2c9b';
    const over = 'sk-saved-too-large-login-8b3f6a1d5e';
    const sized = (key: string, bytes: number) => {
      const start = `{"OPENAI_API_KEY":"${key}","pad":"`;
      return `${start}${'p'.repeat(bytes - start.length - 2)}"}`;
    };
    const first = codexWith(sized(fits, 1_048_576), (home) => ({ CODEX_HOME: home }));
    await runStep(first.executor, first.log);
    const second = codexWith(sized(over, 1_048_577), (home) => ({ CODEX_HOME: home }));
    await runStep(second.executor, second.log);
    expect(redactSecrets(`${fits} ${over}`)).toBe(`<secret:codex.api-key> ${over}`);
  });

  it('is read again before each step and once the turn is over, since Codex renews it', async () => {
    const before = 'sk-saved-before-step-two-7e1b4c9a2f';
    const during = 'sk-saved-during-the-turn-0d5a8f3c6b';
    const directory = project(['@agentclientprotocol/codex-acp']);
    const home = join(directory, '.codex');
    mkdirSync(home);
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, "#!/bin/sh\necho '[]'\n");
    chmodSync(codexBin, 0o755);
    const executor = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, CODEX_HOME: home, ACP_SCRIPT: JSON.stringify([[pass], [pass]]) } }));
    const context = stepContext();
    await executor.runStep(context);
    writeFileSync(join(home, 'auth.json'), login({ OPENAI_API_KEY: before }));
    // The screen is read after the step has started and before its turn ends: a login saved then is one the turn renewed.
    const observe = context.observe;
    (context as { observe: typeof observe }).observe = async (...args) => {
      expect(redactSecrets(before)).toBe('<secret:codex.api-key>');
      writeFileSync(join(home, 'auth.json'), login({ OPENAI_API_KEY: during }));
      return observe(...args);
    };
    await executor.runStep(context);
    expect(redactSecrets(during)).toBe('<secret:codex.api-key>');
  });
});

describe('the environment `codex mcp list` runs in', () => {
  it("gets the config's variables and the runner's, without NODE_DEBUG", async () => {
    const directory = project(['@agentclientprotocol/codex-acp']);
    const log = join(directory, 'agent.jsonl');
    const codexBin = join(directory, 'codex');
    // Lists a server per variable it was given, so the session's config shows what it ran with.
    writeFileSync(codexBin, '#!/bin/sh\nprintf \'[{"name":"playwright"}\'\n[ -n "$E2E_PROBE_CONFIG" ] && printf \',{"name":"executor"}\'\n[ -n "$E2E_PROBE_RUNNER" ] && printf \',{"name":"other"}\'\n[ -n "$NODE_DEBUG" ] && printf \',{"name":"debug"}\'\necho "]"\n');
    chmodSync(codexBin, 0o755);
    vi.stubEnv('E2E_PROBE_RUNNER', '1');
    vi.stubEnv('NODE_DEBUG', 'child_process');
    const executor = inProject(directory, () => codex({ env: { CODEX_PATH: codexBin, E2E_PROBE_CONFIG: '1', ACP_SCRIPT: JSON.stringify([[pass]]), ACP_LOG: log } }));
    const entries = await runStep(executor, log);
    const config = JSON.parse(entries.find((entry) => 'codexConfig' in entry)?.['codexConfig'] as string) as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(config.mcp_servers).toSorted()).toEqual(['executor', 'other', 'playwright']);
  });
});
