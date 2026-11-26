/** Exercises held test attachments through the built CLI and MCP server. */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { AttachHello, AttachRequest, type AttachReply } from '../../src/run/step-attachment-wire.ts';
import { parseLine, readSocketLines, stepAddress } from '../../src/run/step-socket.ts';
import { printedPauseId } from '../helpers/pause-id.ts';
import { contentsUnder, createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const ENV = { ...process.env, CI: '', NO_COLOR: '1' };
const STEP = 'await app.open("/after");';
const PASSWORD = 'fixture-password';
const CREDENTIAL_PASSWORD = 'fixture-credential-password';
const CONFIG = `import { defineTool, getToolContext } from 'e2e/agent';
import { z } from 'zod';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

let appLog;
const { engine } = createFakeEngine({
  video: true,
  pixels: () => ({
    pixels: {
      data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      mediaType: 'image/png',
      width: 1,
      height: 1,
      scale: 1,
    },
    maskedRegionCount: 1,
  }),
  onStartAttempt(context) {
    appLog = context.appLog;
  },
  onNavigate(url) {
    appLog({ level: 'warning', source: 'console', text: 'App log for ' + new URL(url).pathname });
  },
  scene: () => [
    {
      id: 'submit', role: 'button', name: 'Submit',
      on(action, node) {
        if (action.kind === 'tap') {
          node.name = 'Submitted';
        }
      },
    },
    { id: 'email', role: 'textbox', name: 'Email' },
    { id: 'password', role: 'textbox', name: 'Password', inputPurpose: 'password' },
    { id: 'receipt', role: 'status', text: 'Receipt ${PASSWORD}' },
  ],
});

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  secrets: { password: '${PASSWORD}' },
  credentials: { buyer: { username: 'buyer@example.test', password: '${CREDENTIAL_PASSWORD}' } },
  agents: {
    default: {
      tools: {
        checkout_status: defineTool({
          inputSchema: z.object({}),
          execute: async () => 'ready',
        }, { mutates: false }),
        capture_evidence: defineTool({
          inputSchema: z.object({}),
          async execute(_input, options) {
            const context = getToolContext(options);
            const { pixels } = await context.observe({ pixels: true });

            if (pixels === undefined) {
              throw new Error('No pixels to save.');
            }

            return await context.attachScreenshot(pixels, 'checkout-evidence');
          },
        }, { mutates: false }),
      },
    },
  },
  workers: 1,
};
`;

const projects: FixtureProject[] = [];
const runs: ReturnType<typeof spawn>[] = [];
const clients: Client[] = [];

/** Writes a test that opens its app before the given statements run. */
function project(body: string, config = CONFIG): string {
  const created = createProject({
    'e2e.config.ts': config,
    'tests/checkout.e2e.ts': `import { test } from 'e2e';

test('completes checkout', async ({ app, screen }) => {
  await app.open('/checkout');
  ${body}
});
`,
  });
  projects.push(created);
  return created.dir;
}

/** Runs one step command from the project directory. */
function e2e(dir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env: ENV,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

/** Runs until the first explicit pause. */
async function pause(dir: string, ...flags: string[]) {
  const child = spawn(process.execPath, [CLI, 'run', ...flags], {
    cwd: dir,
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runs.push(child);
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
  }
  await vi.waitFor(() => expect(output).toContain('Next: e2e run --step next'), { timeout: 25_000 });
  return { id: printedPauseId(output), exited, output: () => output };
}

/** Opens an MCP client in the run directory with the same temp directory settings. */
async function mcp(dir: string) {
  const temp = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].flatMap((name) => {
    const value = process.env[name];
    return value === undefined ? [] : [[name, value]];
  }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: dir,
    stderr: 'pipe',
    env: { ...temp, E2E_TELEMETRY_DISABLED: '1', E2E_UPDATE_CHECK_DISABLED: '1' },
  });
  const client = new Client({ name: 'step-attachment-test', version: '1.0.0' });
  const log: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => {
    log.push(chunk.toString());
  });
  clients.push(client);
  await client.connect(transport);
  return { client, transport, log };
}

/** Invokes a tool and collects its text, including any error reason. */
async function invoke(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, { timeout: 25_000 });

  return {
    text: result.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n'),
    isError: result.isError === true,
  };
}

/** Opens a session and reads its ID from the reply. */
async function openSession(client: Client, args: Record<string, unknown> = {}) {
  const reply = await invoke(client, 'open_session', args);
  expect(reply.isError, reply.text).toBe(false);
  const session = /^Session (\S+) open on target/.exec(reply.text)?.[1];

  if (session === undefined) {
    throw new Error(`no session id in opening:\n${reply.text}`);
  }

  return { session, text: reply.text };
}

/** Reads the tool names from a session's catalog. */
async function toolNames(client: Client, session: string): Promise<string[]> {
  const reply = await invoke(client, 'tools', { session });
  expect(reply.isError, reply.text).toBe(false);

  return [...reply.text.matchAll(/^- ([\w-]+)[ {:]/gm)].flatMap((match) => match[1] ?? []);
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  try {
    for (const created of projects) e2e(created.dir, 'run', '--step', 'stop');
  } finally {
    for (const run of runs.splice(0)) run.kill();
    for (const created of projects.splice(0)) created.cleanup();
  }
});

describe('MCP attachments to held tests', { timeout: 60_000 }, () => {
  it("reads and drives the paused test's app", async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const opened = await openSession(client, { attach: held.id });
    expect(opened.text).toMatch(/\nScreen: revision \S+, path \/checkout, \d+ nodes, not listed\..*$/);
    expect(opened.text).not.toContain('button "Submit"');
    expect((await invoke(client, 'call', { tool: 'observe' })).text).toContain('button "Submit"');

    const detail = await invoke(client, 'tools', { session: opened.session, tool: 'tap' });
    expect(detail.text).toContain('Arguments (JSON Schema)');
    const located = await invoke(client, 'call', { tool: 'locate', args: { role: 'button', name: 'Submit' } });
    expect(located.text).toContain('1 node matches');
    const observed = await invoke(client, 'call', { tool: 'observe' });
    const target = /^[ \t]*#(\S+) button "Submit"/m.exec(observed.text)?.[1];

    if (target === undefined) {
      throw new Error(observed.text);
    }

    const tapped = await invoke(client, 'call', { tool: 'tap', args: { target } });
    expect(tapped.isError, tapped.text).toBe(false);
    expect(tapped.text).toContain('Submitted');
    const linesTool = await invoke(client, 'tools', { session: opened.session, tool: 'test_lines' });
    expect(linesTool.isError, linesTool.text).toBe(false);
    expect(linesTool.text).toContain('Use these lines at the pause point of the held test');
    expect(linesTool.text).not.toMatch(/split the draft into tests/i);
    const drafted = await invoke(client, 'call', { tool: 'test_lines' });
    expect(drafted.text).toContain('.tap()');
    expect(drafted.text).toContain('Put them in the held test at the pause point');
    expect(drafted.text).not.toMatch(/split these lines into tests/i);
    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
  });

  it('redacts a displayed secret from the screen, tool results, and errors', async () => {
    const dir = project(`await app.open('/reset/${PASSWORD}'); await screen.pause();`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const opened = await openSession(client, { attach: held.id });
    const observed = await invoke(client, 'call', { tool: 'observe' });
    const located = await invoke(client, 'call', { tool: 'locate', args: { role: 'status' } });
    const failed = await invoke(client, 'call', { tool: PASSWORD });

    expect(observed.isError).toBe(false);
    expect(located.isError).toBe(false);
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('UNKNOWN_TOOL');
    // The opening names the screen by its path, where the value sits URL-encoded once redacted.
    expect(opened.text).toContain('path /reset/%3Csecret:password%3E,');
    expect(opened.text).not.toContain(PASSWORD);
    for (const text of [observed.text, located.text, failed.text]) {
      expect(text).toContain('<secret:password>');
      expect(text).not.toContain(PASSWORD);
    }
  });

  it('attaches at a stepped hold and prints the same id in the next pause header', async () => {
    const dir = project(`await app.open("/review"); ${STEP}`);
    const first = e2e(dir, 'run', '--step');
    expect(first.status).toBe(0);
    const id = printedPauseId(first.stdout);
    expect(first.stdout).toContain(`Paused (${id}) before step 2`);
    const { client } = await mcp(dir);
    const opened = await openSession(client, { attach: id });

    const next = e2e(dir, 'run', '--step', 'next');
    expect(next.status).toBe(0);
    expect(next.stdout).toContain(`Paused (${id}) before step 3`);
    await vi.waitFor(async () => {
      const later = await invoke(client, 'call', { session: opened.session, tool: 'observe' });
      expect(later.isError).toBe(true);
      expect(later.text).toContain('the test resumed');
    });
    expect(e2e(dir, 'run', '--step', 'rest').status).toBe(0);
  });

  it('lists held tests and their ids when an attachment id is unknown', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const unknown = `${held.id.startsWith('a') ? 'b' : 'a'}${held.id.slice(1)}`;
    const reply = await invoke(client, 'open_session', { attach: unknown });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('Held tests:');
    expect(reply.text).toContain(`${held.id}  completes checkout [fake]`);
  });

  it('explains how to hold a test when no run listens in this directory', async () => {
    const dir = project(STEP);
    const { client } = await mcp(dir);
    const reply = await invoke(client, 'open_session', { attach: 'unmatched' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('No test in this directory is held');
    expect(reply.text).toContain('screen.pause()');
    expect(reply.text).toContain('e2e run <files> --step');
  });

  it('names each argument that cannot be combined with attach', async () => {
    const { client } = await mcp(project(STEP));
    const excluded = {
      target: 'fake',
      config: 'e2e.config.ts',
      test: 'checkout',
      engine: '@e2e-dev/web',
      app: {},
      path: '/echo',
      headed: false,
    };

    for (const [field, value] of Object.entries(excluded)) {
      const reply = await invoke(client, 'open_session', { attach: 'unmatched', [field]: value });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain(`INVALID_ARGUMENT: open_session: attach cannot be combined with ${field}`);
    }
  });

  it('leaves the test held and attachable again after close_session', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const first = await openSession(client, { attach: held.id });
    expect((await invoke(client, 'close_session', { session: first.session })).isError).toBe(false);
    const second = await openSession(client, { attach: held.id });
    expect(second.session).not.toBe(first.session);
    expect(second.text).toContain('path /checkout');
  });

  it('closes the MCP session when the test resumes before detach is acknowledged', async () => {
    const dir = project(STEP);
    let peer: net.Socket | undefined;
    // Reply to detach with ended so the test controls which frame arrives first.
    const server = net.createServer((socket) => {
      peer = socket;
      readSocketLines(socket, (line) => {
        const hello = parseLine(line, AttachHello);

        if (hello !== undefined) {
          socket.write(`${JSON.stringify(hello)}\n`);
          return true;
        }

        switch (parseLine(line, AttachRequest)?.type) {
          case 'attach': {
            const reply: AttachReply = {
              type: 'opening',
              opening: {
                target: 'fake',
                platform: 'fake',
                headed: false,
                projectTools: [],
                summary: '',
                catalog: [],
                observation: '',
              },
            };
            socket.write(`${JSON.stringify(reply)}\n`);
            return true;
          }

          case 'detach': {
            const reply: AttachReply = { type: 'ended', reason: 'the test resumed' };
            socket.end(`${JSON.stringify(reply)}\n`);
            return false;
          }

          default:
            socket.destroy();
            return false;
        }
      });
    });

    try {
      const listening = once(server, 'listening');
      server.listen(stepAddress(dir).socket);
      await listening;

      const { client } = await mcp(dir);
      const { session } = await openSession(client, { attach: 'fixture' });
      const closed = await invoke(client, 'close_session', { session });
      expect(closed.isError, closed.text).toBe(false);
      expect(closed.text).toContain(`Session ${session} closed`);
    } finally {
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('can observe the same session after cancelling an action in progress', async () => {
    const dir = project('await screen.pause();', `import { writeFileSync } from 'node:fs';
${CONFIG.replace('  video: true,', `  video: true,
  async perform(_ref, _action, { signal }) {
    writeFileSync(new URL('./action-started', import.meta.url), '');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    writeFileSync(new URL('./action-cancelled', import.meta.url), '');
    throw new Error('tap cancelled');
  },`)}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const { session } = await openSession(client, { attach: held.id });
    const { text } = await invoke(client, 'call', { tool: 'observe' });
    const target = /^[ \t]*#(\S+) button "Submit"/m.exec(text)?.[1];

    if (target === undefined) {
      throw new Error(text);
    }

    const cancel = new AbortController();
    const call = client.callTool(
      { name: 'call', arguments: { session, tool: 'tap', args: { target } } },
      { timeout: 25_000, signal: cancel.signal },
    );
    const cancelled = expect(call).rejects.toThrow();

    try {
      await vi.waitFor(() => expect(existsSync(path.join(dir, 'action-started'))).toBe(true), { timeout: 5_000 });
    } finally {
      cancel.abort();
      await cancelled;
    }

    await vi.waitFor(() => expect(existsSync(path.join(dir, 'action-cancelled'))).toBe(true), { timeout: 5_000 });
    const observed = await invoke(client, 'call', { session, tool: 'observe' });
    expect(observed.isError, observed.text).toBe(false);
    expect(observed.text).toContain('path /checkout');
  });

  it('logs the saved recording and leaves the test attachable after the MCP server is killed', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const first = await mcp(dir);
    const { session } = await openSession(first.client, { attach: held.id });
    const started = await invoke(first.client, 'call', { session, tool: 'start_recording', args: { name: 'disconnected' } });
    expect(started.isError, started.text).toBe(false);
    const pid = first.transport.pid;

    if (pid === null) {
      throw new Error('MCP server did not start');
    }

    process.kill(pid, 'SIGKILL');

    const { client } = await mcp(dir);
    const reopened = await vi.waitFor(() => openSession(client, { attach: held.id }), { timeout: 5_000 });
    expect(reopened.text).toContain('path /checkout');
    const file = path.join(dir, '.e2e/videos', session, '1-disconnected.webm');
    await vi.waitFor(() => expect(held.output()).toContain(file));
    expect(readFileSync(file).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  });

  it('keeps attached actions and their app logs out of the report and the trace page', async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir, '--trace', 'on');
    const { client } = await mcp(dir);
    await openSession(client, { attach: held.id });
    const navigated = await invoke(client, 'call', { tool: 'navigate', args: { url: '/attached-only' } });
    expect(navigated.isError, navigated.text).toBe(false);
    expect(navigated.text).toContain('/attached-only');

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
    const report: Report1Document = JSON.parse(readFileSync(path.join(dir, '.e2e/report.json'), 'utf8'));
    expect(report.run.results[0]?.attempts[0]?.steps.map(({ api, label }) => ({ api, label }))).toEqual([
      { api: 'app.open', label: '/checkout' },
      { api: 'app.open', label: '/after' },
    ]);
    expect(JSON.stringify(report)).not.toContain('/attached-only');
    const pages = contentsUnder(path.join(dir, '.e2e/results')).filter(([file]) => file.endsWith('trace.md'));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.[1]).toContain('App log for /after');
    expect(pages[0]?.[1]).not.toContain('/attached-only');
  });

  it('lists the normal session tools, saves project tool evidence, and keeps the run video', async () => {
    const dir = project('await screen.pause();');
    const { client } = await mcp(dir);
    const normal = await openSession(client);
    const normalTools = await toolNames(client, normal.session);
    expect(normalTools).toEqual(expect.arrayContaining([
      'checkout_status', 'capture_evidence', 'start_recording', 'stop_recording',
    ]));
    expect((await invoke(client, 'close_session', { session: normal.session })).isError).toBe(false);

    const held = await pause(dir, '--video', 'on');
    const attached = await openSession(client, { attach: held.id });
    const attachedTools = await toolNames(client, attached.session);
    expect(attachedTools.toSorted()).toEqual(normalTools.toSorted());
    expect((await invoke(client, 'call', { tool: 'checkout_status' })).text).toBe('ready');

    const captured = await invoke(client, 'call', { tool: 'capture_evidence' });
    const evidence = path.join(dir, '.e2e/results/mcp', attached.session, 'checkout-evidence.png');
    expect(captured.isError, captured.text).toBe(false);
    expect(captured.text).toBe(`${attached.session}:artifact:0`);
    expect(readFileSync(evidence).subarray(1, 4).toString()).toBe('PNG');

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
    expect(readFileSync(path.join(dir, '.e2e/report.json'), 'utf8')).not.toContain(captured.text);
    expect(contentsUnder(path.join(dir, '.e2e/results')).map(([file]) => file)).toEqual(
      expect.arrayContaining([expect.stringMatching(/fake\.webm$/)]),
    );
    expect(existsSync(path.join(dir, '.e2e/videos', attached.session))).toBe(false);
  });

  it('saves attached recordings under their session IDs and returns the paths', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir, '--video', 'on-first-retry');
    const { client } = await mcp(dir);
    const normal = await openSession(client);
    const first = await openSession(client, { attach: held.id });
    const sessions = [normal.session, first.session];

    for (const session of sessions) {
      const started = await invoke(client, 'call', { session, tool: 'start_recording', args: { name: 'demo' } });
      expect(started.isError, started.text).toBe(false);
      expect(started.text).toContain('Recording 1 "demo" started.');

      const stopped = await invoke(client, 'call', { session, tool: 'stop_recording' });
      expect(stopped.isError, stopped.text).toBe(false);
      const file = path.join(dir, '.e2e/videos', session, '1-demo.webm');
      expect(stopped.text).toContain(`- ${file}`);
      expect(readFileSync(file).subarray(0, 4).toString('hex')).toBe('1a45dfa3');

      expect((await invoke(client, 'close_session', { session })).isError).toBe(false);
    }

    const second = await openSession(client, { attach: held.id });
    expect(new Set([...sessions, second.session]).size).toBe(3);
    const started = await invoke(client, 'call', { session: second.session, tool: 'start_recording', args: { name: 'demo' } });
    expect(started.isError, started.text).toBe(false);

    const closed = await invoke(client, 'close_session', { session: second.session });
    const file = path.join(dir, '.e2e/videos', second.session, '1-demo.webm');
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.text).toContain(`- ${file}`);
    expect(readFileSync(file).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  });

  it('refuses to start a recording and reports where the run saves its video', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir, '--video', 'on');
    const { client } = await mcp(dir);
    const { session } = await openSession(client, { attach: held.id });

    const refused = await invoke(client, 'call', { session, tool: 'start_recording' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('The run already records this test.');

    const stopped = await invoke(client, 'call', { session, tool: 'stop_recording' });
    expect(stopped.isError, stopped.text).toBe(false);
    expect(stopped.text).toContain('Nothing is recording');
    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);

    const videos = contentsUnder(path.join(dir, '.e2e/results')).filter(([file]) => file.endsWith('.webm'));
    expect(videos).toHaveLength(1);
    expect(refused.text).toContain(path.dirname(videos[0]?.[0] ?? ''));
    expect(existsSync(path.join(dir, '.e2e/videos', session))).toBe(false);
  });

  it('resumes the test and ends the attachment before the recording saves, then logs the path', async () => {
    const dir = project(
      `await screen.pause();
      const { writeFileSync } = await import('node:fs');
      writeFileSync(new URL('../test-resumed', import.meta.url), '');
      ${STEP}`,
      `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
${CONFIG.replace('  video: true,', `  video: true,
  async onStopVideo() {
    writeFileSync(new URL('./stop-started', import.meta.url), '');

    while (!existsSync(new URL('./finish-save', import.meta.url))) {
      await sleep(20);
    }
  },`).replace('  workers: 1,', '  workers: 1,\n  cleanupTimeout: 15_000,')}`,
    );
    const held = await pause(dir);
    const server = await mcp(dir);
    const { client } = server;
    const { session } = await openSession(client, { attach: held.id });

    const started = await invoke(client, 'call', { session, tool: 'start_recording', args: { name: 'paused' } });
    expect(started.isError, started.text).toBe(false);

    const file = path.join(dir, '.e2e/videos', session, '1-paused.webm');
    const next = spawn(process.execPath, [CLI, 'run', '--step', 'next'], {
      cwd: dir,
      env: ENV,
      stdio: 'ignore',
    });
    const nextExit = once(next, 'close');

    try {
      await vi.waitFor(() => {
        expect(existsSync(path.join(dir, 'stop-started'))).toBe(true);
        expect(existsSync(path.join(dir, 'test-resumed'))).toBe(true);
        expect(server.log.join('')).toContain(`session ${session} ended: the test resumed`);
      }, { timeout: 5_000 });

      const closed = await invoke(client, 'tools', { session });
      expect(closed.isError).toBe(true);
      expect(closed.text).toContain('the test resumed');
      expect(existsSync(file)).toBe(false);
    } finally {
      writeFileSync(path.join(dir, 'finish-save'), '');
    }

    expect((await nextExit)[0]).toBe(0);
    expect(await held.exited).toBe(0);
    expect(readFileSync(file).subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(held.output()).toContain(file);
    await vi.waitFor(() => expect(server.log.join('')).toContain(file));
  });

  it('runs test statements under the call timeout and leaves them out of the report', async () => {
    const dir = project(`test.setTimeout(750); await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    await sleep(750);
    const { client } = await mcp(dir);
    await openSession(client, { attach: held.id });

    const ran = await invoke(client, 'call', {
      tool: 'run_code',
      args: {
        code: 'await app.open("/from-code"); await screen.getByRole("button", "Submit").tap();',
        timeout: 500,
      },
    });
    expect(ran.isError, ran.text).toBe(false);
    expect(ran.text).toContain('Test lines: 2.');
    expect(ran.text).toContain('Submitted');
    expect((await invoke(client, 'call', { tool: 'test_lines' })).text).toContain("await app.open('/from-code');");

    const missed = await invoke(client, 'call', {
      tool: 'run_code',
      args: { code: 'await screen.getByRole("button", "Missing").tap();', timeout: 50 },
    });
    expect(missed.isError, missed.text).toBe(true);
    expect(missed.text).toContain('Test lines: 1, 1 failed.');
    expect(missed.text).toContain('LOCATOR_NOT_FOUND');

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
    const report = readFileSync(path.join(dir, '.e2e/report.json'), 'utf8');
    expect(report).toContain('/after');
    expect(report).not.toContain('/from-code');
    expect(report).not.toContain('Missing');
  });

  it("keeps what attached run_code leaves behind out of the held test's verdict", async () => {
    const dir = project(`await screen.pause(); ${STEP}`);
    const held = await pause(dir);
    const { client } = await mcp(dir);
    await openSession(client, { attach: held.id });
    const run = (code: string) => invoke(client, 'call', { tool: 'run_code', args: { code } });

    // A soft failure is the call's, not the test's.
    const soft = await run('expect.soft(1).toBe(2);');
    expect(soft.isError, soft.text).toBe(true);
    expect(soft.text).toContain('1 soft assertion failed');
    // Thrown outside the code's own promise, while the call runs: the call fails.
    const microtask = await run("queueMicrotask(() => { throw new Error('in a microtask'); });\nawait new Promise((resolve) => setTimeout(resolve, 100));");
    expect(microtask.text).toContain('Error: in a microtask');
    // Thrown after the call ended: nobody is left to fail, and the worker goes on.
    expect((await run("setTimeout(() => { throw new Error('late'); }, 150);\nreturn 'returned';")).text).toContain('Returned: "returned"');
    await sleep(400);

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
  });

  it("reads the config's services in attached run_code and calls their functions in the run's process", async () => {
    const config = `import { appendFileSync } from 'node:fs';
${CONFIG.replace('export default {', `const inbox = {
  async *start() {
    yield {
      url: 'http://inbox.test',
      record: (what: string) => {
        appendFileSync('events.log', 'record ' + what + '\\n');

        return what.length;
      },
    };
  },
};

export default {
  services: { inbox },`)}`;

    const dir = project(`await screen.pause(); ${STEP}`, config);
    const held = await pause(dir);
    const { client } = await mcp(dir);

    await openSession(client, { attach: held.id });

    const ran = await invoke(client, 'call', {
      tool: 'run_code',
      args: { code: "return { url: services.inbox.url, length: await services.inbox.record('attached') };" },
    });

    expect(ran.isError, ran.text).toBe(false);
    expect(ran.text).toContain('{"url":"http://inbox.test","length":8}');
    expect(readFileSync(path.join(dir, 'events.log'), 'utf8')).toBe('record attached\n');

    expect(e2e(dir, 'run', '--step', 'next').status).toBe(0);
    expect(await held.exited).toBe(0);
  });

  it('fills configured secrets only into authorized fields and redacts their values', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    const opened = await openSession(client, { attach: held.id });
    expect(opened.text).toContain('"buyer" (username "buyer@example.test", password secret "buyer.password")');
    expect(opened.text).toContain('Secrets: "password"');
    const screen = await invoke(client, 'call', { tool: 'observe' });
    const email = /^[ \t]*#(\S+) textbox "Email"/m.exec(screen.text)?.[1];

    if (email === undefined) {
      throw new Error(screen.text);
    }

    const denied = await invoke(client, 'call', { tool: 'type_secret', args: { target: email, name: 'buyer.password' } });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('POLICY_DENIED');

    const filled = await invoke(client, 'call', { tool: 'type_secret', args: { target: email, name: 'password' } });
    expect(filled.isError, filled.text).toBe(false);
    expect(filled.text).toContain('Filled secret "password"');
    const observed = await invoke(client, 'call', { tool: 'observe' });
    expect(observed.text).toMatch(/textbox "Email".*<secret:password>/);
    const password = /^[ \t]*#(\S+) textbox "Password"/m.exec(observed.text)?.[1];

    if (password === undefined) {
      throw new Error(observed.text);
    }

    const entered = await invoke(client, 'call', { tool: 'type_secret', args: { target: password, name: 'buyer.password' } });
    expect(entered.isError, entered.text).toBe(false);
    const lines = await invoke(client, 'call', { tool: 'test_lines' });
    expect(lines.text).toContain('credentials.user("buyer").password');

    for (const text of [opened.text, denied.text, filled.text, observed.text, entered.text, lines.text]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(CREDENTIAL_PASSWORD);
    }
  });

  it('fills a password through attached run_code and keeps its value out of the output', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir, '--trace', 'on');
    const { client, log } = await mcp(dir);
    const opened = await openSession(client, { attach: held.id });
    const allowed = await invoke(client, 'call', {
      tool: 'run_code',
      args: { code: 'await screen.getByRole("textbox", "Password").fill(credentials.user("buyer").password);' },
    });
    expect(allowed.isError, allowed.text).toBe(false);
    expect(allowed.text).toContain('Test lines: 1.');

    const observed = await invoke(client, 'call', { tool: 'observe' });
    expect(observed.text).toMatch(/textbox "Password".*<secret:buyer\.password>/);
    expect(observed.text).not.toMatch(/textbox "Email".*<secret:buyer\.password>/);

    const lines = await invoke(client, 'call', { tool: 'test_lines' });
    expect(lines.text).toContain("getByRole('textbox', 'Password').fill(credentials.user('buyer').password)");

    const next = e2e(dir, 'run', '--step', 'next');
    expect(next.status).toBe(0);
    expect(await held.exited).toBe(0);

    const output = [
      opened.text,
      allowed.text,
      observed.text,
      lines.text,
      held.output(),
      next.stdout,
      next.stderr,
      ...log,
      ...contentsUnder(path.join(dir, '.e2e')).flat(),
    ].join('\n');
    expect(output).not.toContain(CREDENTIAL_PASSWORD);
  });

  it('saves a masked attached screenshot to the requested project path', async () => {
    const dir = project('await screen.pause();');
    const held = await pause(dir);
    const { client } = await mcp(dir);
    await openSession(client, { attach: held.id });
    const screenshot = await invoke(client, 'tools', { tool: 'screenshot' });
    expect(screenshot.text).toContain('"path"');

    const saved = await invoke(client, 'call', { tool: 'screenshot', args: { path: 'shots/checkout.png' } });
    const file = path.join(dir, 'shots/checkout.png');
    expect(saved.isError, saved.text).toBe(false);
    expect(saved.text).toContain(`Saved to ${file}`);
    expect(readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
    expect(contentsUnder(path.join(dir, '.e2e/results')).map(([name]) => name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/screenshots\/fake\.png$/)]),
    );
  });

  it('names both e2e versions when attachment protocols differ', async () => {
    const dir = project('await screen.pause();');
    await pause(dir);
    const version = e2e(dir, '--version').stdout.trim();
    const socket = net.connect(stepAddress(dir).socket);
    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let text = '';
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.on('data', (chunk: string) => {
          text += chunk;
        });
        socket.once('end', () => resolve(text));
        socket.once('connect', () => socket.write('{"type":"hello","protocol":999,"version":"9.9.9"}\n'));
      });
      expect(JSON.parse(reply)).toMatchObject({
        type: 'error',
        category: 'configuration',
        message: expect.stringContaining(`e2e mcp (e2e 9.9.9) and e2e run (e2e ${version})`),
      });
      expect(reply).toContain('Run the same e2e version for e2e mcp and e2e run.');
    } finally {
      socket.destroy();
    }
  });
});
