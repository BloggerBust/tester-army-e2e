/**
 * A coding agent that repeats a credential, because its model provider
 * quoted it back in an error or for any other reason, must not put it into
 * anything the run writes. Through the built CLI, real Chromium, and the
 * `codex()` preset on the scripted agent: the key in the runner's
 * environment, and the key and tokens Codex saved in `CODEX_HOME/auth.json`,
 * which can differ from the environment's, each come back through every way
 * the agent's text reaches the report (a `complete_step` summary, an
 * assertion's verdict, a tool title, reply text, a turn's error). The
 * terminal, the report, the summary, and every trace page hold none of
 * them, not even in part.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const AGENT = fileURLToPath(new URL('./fixtures/scripted-agent.ts', import.meta.url));
/** The run of 8 characters the redactor treats as a fragment of a value. */
const FRAGMENT = 8;

/** A fake credential: a fixed prefix and a random part, which alone is matched in the output. */
function credential(prefix: string): { value: string; random: string } {
  const random = randomBytes(16).toString('hex');
  return { value: `${prefix}${random}`, random };
}

const credentials = {
  environment: credential('sk-env-'),
  saved: credential('sk-saved-'),
  access: credential('at-'),
  refresh: credential('rt-'),
};
const all = Object.values(credentials).map(({ value }) => value).join(' ');
const failed = (summary: string) => ({ call: 'complete_step', args: { status: 'failed', summary } });
/** What the agent does for each step: repeat every credential through one path. */
const SCRIPT = {
  'Step: Summary path.': [failed(`summary ${all}`)],
  'Assertion: Verdict path.': [failed(`verdict ${all}`)],
  'Step: Title path.': [{ ran: `title ${all}` }],
  'Step: Reply path.': [{ say: `reply ${all}` }],
  'Step: Error path.': [{ fail: `error ${all}` }],
};

function files(directory: string): [string, string][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry): [string, string][] => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [[path, readFileSync(path, 'latin1')]];
  });
}

/** Which credentials `text` holds a piece of, plainly or URL-encoded. */
function leaked(text: string): string[] {
  return Object.entries(credentials)
    .filter(([, { value, random }]) => {
      for (let at = value.length - random.length; at + FRAGMENT <= value.length; at += 1) {
        const piece = value.slice(at, at + FRAGMENT);
        if (text.includes(piece) || text.includes(encodeURIComponent(piece))) return true;
      }
      return false;
    })
    .map(([name]) => name);
}

describe('credentials an agent repeats, through the built CLI', () => {
  let directory: string;
  let app: Server;
  let output = '';
  let written: [string, string][] = [];

  beforeAll(async () => {
    app = createServer((_, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><html><body><h1>Probe</h1><button>Go</button></body></html>');
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const address = app.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    directory = mkdtempSync(join(tmpdir(), 'e2e-acp-key-echo-'));
    mkdirSync(join(directory, 'node_modules/@e2e-dev'), { recursive: true });
    symlinkSync(join(root, 'e2e'), join(directory, 'node_modules/e2e'));
    symlinkSync(join(root, 'acp'), join(directory, 'node_modules/@e2e-dev/acp'));
    symlinkSync(join(root, 'web'), join(directory, 'node_modules/@e2e-dev/web'));
    // The scripted agent, installed under the Codex adapter's name.
    const adapter = join(directory, 'node_modules/@agentclientprotocol/codex-acp');
    mkdirSync(join(adapter, 'dist'), { recursive: true });
    writeFileSync(join(adapter, 'package.json'), JSON.stringify({ name: '@agentclientprotocol/codex-acp', bin: { 'codex-acp': 'dist/index.js' } }));
    writeFileSync(join(adapter, 'dist/index.js'), `import ${JSON.stringify(AGENT)};\n`);
    // Stands in for the Codex the adapter runs, with no MCP servers of the user's.
    const codexBin = join(directory, 'codex');
    writeFileSync(codexBin, "#!/bin/sh\necho '[]'\n");
    chmodSync(codexBin, 0o755);
    // A login Codex saved earlier, with a key other than the environment's.
    const codexHome = join(directory, 'codex-home');
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'apikey',
        OPENAI_API_KEY: credentials.saved.value,
        tokens: { access_token: credentials.access.value, refresh_token: credentials.refresh.value, account_id: 'acct-probe' },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, 'e2e.config.ts'),
      [
        'import { web } from "@e2e-dev/web";',
        'import { codex } from "@e2e-dev/acp";',
        'export default {',
        '  tests: "echo.e2e.ts",',
        '  cache: "off",',
        `  targets: [{ engine: web(), app: { url: ${JSON.stringify(`http://127.0.0.1:${address.port}`)} } }],`,
        '  agents: { default: { executor: codex({ env: {',
        `    CODEX_PATH: ${JSON.stringify(codexBin)},`,
        `    CODEX_HOME: ${JSON.stringify(codexHome)},`,
        `    ACP_SCRIPT: ${JSON.stringify(JSON.stringify(SCRIPT))},`,
        '  } }) } },',
        '};',
      ].join('\n'),
    );
    const step = (title: string, call: string) =>
      `test(${JSON.stringify(title)}, async ({ app, agent }) => {\n  await app.open("/");\n  await agent.${call}(${JSON.stringify(`${title[0]!.toUpperCase()}${title.slice(1)} path.`)});\n});\n`;
    writeFileSync(
      join(directory, 'echo.e2e.ts'),
      `import { test } from "e2e";\n${step('summary', 'act')}${step('verdict', 'assert')}${step('title', 'act')}${step('reply', 'act')}${step('error', 'act')}`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1', CI: '', OPENAI_API_KEY: credentials.environment.value };
    for (const name of ['CODEX_API_KEY', 'DEFAULT_AUTH_REQUEST', 'APP_SERVER_LOGS', 'NODE_DEBUG', 'CODEX_HOME']) delete env[name];
    try {
      const result = await execFileAsync(process.execPath, [join(root, 'e2e/dist/cli/bin.js'), 'run', '--workers', '1', '--reporter', 'list,markdown'], {
        cwd: directory,
        env,
        timeout: 120_000,
      });
      output = result.stdout + result.stderr;
    } catch (error) {
      const result = z.object({ stdout: z.string(), stderr: z.string() }).parse(error);
      output = result.stdout + result.stderr;
    }
    written = files(join(directory, '.e2e'));
  }, 180_000);

  afterAll(async () => {
    if (app) await new Promise<void>((resolve) => app.close(() => resolve()));
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('ran every step on the agent, so each path reached the report', () => {
    const report = JSON.parse(readFileSync(join(directory, '.e2e/report.json'), 'utf8')) as { run: { results: { titlePath: string[]; status: string }[] } };
    expect(report.run.results.map((result) => [result.titlePath.at(-1), result.status])).toEqual([
      ['summary', 'failed'],
      ['verdict', 'failed'],
      ['title', 'failed'],
      ['reply', 'failed'],
      ['error', 'failed'],
    ]);
    // Each path's text is in the report with a marker where each credential was: redacted, not dropped.
    const markers = '<secret:OPENAI_API_KEY> <secret:codex.api-key> <secret:codex.access-token> <secret:codex.refresh-token>';
    const reported = readFileSync(join(directory, '.e2e/report.json'), 'utf8');
    for (const path of ['summary', 'verdict', 'title', 'reply', 'error']) expect(reported).toContain(`${path} ${markers}`);
  });

  it('prints no piece of a credential to the terminal', () => {
    // The agent's text is there, with a marker where the credentials were: redacted, not dropped.
    expect(output).toContain('summary <secret:OPENAI_API_KEY> <secret:codex.api-key>');
    expect(leaked(output)).toEqual([]);
  });

  it('writes no piece of a credential to the report, the summary, or a trace page', () => {
    const names = written.map(([path]) => relative(directory, path));
    expect(names).toEqual(expect.arrayContaining(['.e2e/report.json', '.e2e/summary.md']));
    // A trace page per test, each holding the markers.
    const traces = written.filter(([path]) => path.endsWith('trace.md'));
    expect(traces).toHaveLength(5);
    for (const [, content] of traces) expect(content).toContain('<secret:OPENAI_API_KEY>');
    const leaks = written.flatMap(([path, content]) => leaked(content).map((name) => `${relative(directory, path)}: ${name}`));
    expect(leaks).toEqual([]);
  });
});
