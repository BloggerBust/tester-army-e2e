/**
 * `e2e run` with user code that prints a configured secret outside any test
 * body: the config's top-level code (in the runner and again in each
 * worker), a test file's top level while the runner collects it, a custom
 * reporter, and timers or exit hooks any of them leave to print after the
 * run. What each prints reaches the terminal redacted, as a test's
 * output does. A config that prints a secret and then fails to load has no
 * secrets anyone knows, so what it printed is withheld, not passed on raw.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@e2e-dev/core/lib/agent/public';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProject, runExisting, runExistingWithConfigFile, type FixtureProject, type RunOptions } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));

const TOKEN = 'run-output-token-42';

/** Prints once the run is over. */
const AFTER_RUN = `process.once('beforeExit', () => {
  console.log(\`after the run: \${token}\`);
  process.stdout.write(\`after the run, unfinished: \${token.slice(0, 9)}\`);
});
`;

const CONFIG = `import { defineEngine } from 'e2e/engine';

const token = '${TOKEN}';
console.log(\`config console.log: \${token}\`);
console.error(\`config console.error: \${token}\`);
process.stdout.write(\`config split: \${token.slice(0, 9)}\`);
process.stdout.write(\`\${token.slice(9)}\\n\`);
${AFTER_RUN}
export default {
  targets: [{ name: 'headless', platform: 'test', engine: defineEngine({ name: 'noop', version: '1', spiVersion: 1 }) }],
  workers: 1,
  secrets: { apiToken: token },
  reporters: ['list', {
    name: 'chatty',
    onEvent(event) {
      if (event.type === 'collected') console.log(\`reporter onEvent: \${token}\`);
      if (event.type === 'run-finished') process.stdout.write(\`reporter unfinished: \${token}\`);
    },
    onRunFinished() {
      console.error(\`reporter onRunFinished: \${token}\`);
      setTimeout(() => console.error(\`reporter timer: \${token}\`), 50);
    },
  }],
};
`;

const TEST = `import { test } from 'e2e';

console.log('test file top level: ${TOKEN}');

test('prints', () => {
  console.log('test body: ${TOKEN}');
});
`;

const BROKEN_CONFIG = `console.log('broken config: ${TOKEN}');
throw new Error('config refuses to load');
`;

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** An embedded run: `run` from `e2e/runner`, which is quiet. */
const EMBEDDED = ['--input-type=module', '-e', "import { run } from 'e2e/runner'; process.exitCode = (await run({ cwd: process.cwd() })).exitCode;"];

function runCli(files: Record<string, string>, args: readonly string[] = [], command: readonly string[] = [CLI, 'run']) {
  const project = createProject(files);
  projects.push(project);
  const cli = spawnSync(process.execPath, [...command, ...args], {
    cwd: project.dir,
    env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(cli.error).toBeUndefined();
  return cli;
}

describe('e2e run redacts what user code prints outside a test', () => {
  it('redacts the config, a collected test file, and a reporter on stdout and stderr', () => {
    const cli = runCli({ 'e2e.config.ts': CONFIG, 'tests/print.e2e.ts': TEST });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(output).not.toContain(TOKEN);
    // The runner prints nothing on stdout itself, not even what user code leaves for after the run.
    expect(cli.stderr).toContain(`after the run, unfinished: ${TOKEN.slice(0, 9)}`);
    const lines = output.split('\n');
    for (const line of [
      'config console.log: <secret:apiToken>',
      'config console.error: <secret:apiToken>',
      'config split: <secret:apiToken>',
      'test file top level: <secret:apiToken>',
      'reporter onEvent: <secret:apiToken>',
      'reporter onRunFinished: <secret:apiToken>',
      'reporter unfinished: <secret:apiToken>',
      'test body: <secret:apiToken>',
      'reporter timer: <secret:apiToken>',
      'after the run: <secret:apiToken>',
    ]) {
      expect(lines).toContain(line);
    }
  });

  it('hands output to every reporter as an event, beside list, with where it came from', () => {
    const mirrored = CONFIG.replace("import { defineEngine }", "import { appendFileSync } from 'node:fs';\nimport { defineEngine }").replace(
      "reporters: ['list', {",
      `reporters: ['list', {
    name: 'mirror',
    onEvent(event) {
      if (event.type !== 'output') return;
      const { stream, text, target, pair } = event;
      appendFileSync('mirror.jsonl', JSON.stringify({ stream, text, target, pair }) + '\\n');
    },
  }, {`,
    );
    const cli = runCli({ 'e2e.config.ts': mirrored, 'tests/print.e2e.ts': TEST });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const project = projects.at(-1)!;
    const mirror = readFileSync(path.join(project.dir, 'mirror.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mirror).toContainEqual({ stream: 'stdout', text: 'test file top level: <secret:apiToken>\n' });
    expect(mirror).toContainEqual(expect.objectContaining({ stream: 'stdout', text: 'test body: <secret:apiToken>\n', target: 'headless', pair: expect.objectContaining({ repeat: 0 }) }));
    expect(JSON.stringify(mirror)).not.toContain(TOKEN);
    // list still shows both.
    expect(cli.stdout.split('\n')).toEqual(expect.arrayContaining(['test file top level: <secret:apiToken>', 'test body: <secret:apiToken>']));
  });

  it('shows what a reporter prints while it is handed output through list, once, and in order without it', () => {
    const logger = `{
    name: 'logger',
    onEvent(event) {
      if (event.type === 'output' && event.target !== undefined) console.log('LOGGER saw ' + JSON.stringify(event.text));
    },
  }`;
    const beside = (first: string) => CONFIG.replace("reporters: ['list', {", `reporters: ['${first}', ${logger}, {`);
    const listed = runCli({ 'e2e.config.ts': beside('list'), 'tests/print.e2e.ts': TEST });
    expect(listed.status, listed.stdout + listed.stderr).toBe(0);
    const saw = 'LOGGER saw "test body: <secret:apiToken>\\n"';
    expect(listed.stdout.split('\n').filter((line) => line === saw)).toHaveLength(1);
    expect(listed.stderr).not.toContain('LOGGER saw');

    // Without list the runner prints both, the test's line before what the logger said of it.
    const plain = runCli({ 'e2e.config.ts': beside('junit'), 'tests/print.e2e.ts': TEST });
    expect(plain.status, plain.stdout + plain.stderr).toBe(0);
    const lines = plain.stderr.split('\n');
    expect(lines.filter((line) => line === saw)).toHaveLength(1);
    expect(lines.indexOf('test body: <secret:apiToken>')).toBeGreaterThan(-1);
    expect(lines.indexOf('test body: <secret:apiToken>')).toBeLessThan(lines.indexOf(saw));
  });

  it('still prints output itself, on stderr, when no interactive reporter shows it, whoever else records it', () => {
    const mirrored = CONFIG.replace("import { defineEngine }", "import { appendFileSync } from 'node:fs';\nimport { defineEngine }").replace(
      "reporters: ['list', {",
      `reporters: ['list', {
    name: 'mirror',
    onEvent(event) {
      if (event.type !== 'output') return;
      const { stream, text, target, pair } = event;
      appendFileSync('mirror.jsonl', JSON.stringify({ stream, text, target, pair }) + '\\n');
      setTimeout(() => process.stdout.write('echo\\n'), 0);
    },
  }, {`,
    );
    const cli = runCli({ 'e2e.config.ts': mirrored, 'tests/print.e2e.ts': TEST }, ['--reporter', 'json']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ schemaVersion: 'report-1' });
    expect(cli.stderr.split('\n')).toEqual(expect.arrayContaining(['test file top level: <secret:apiToken>', 'reporter onEvent: <secret:apiToken>', 'test body: <secret:apiToken>']));
    // Each test write reaches the mirror once, naming its test.
    const project = projects.at(-1)!;
    const mirror = readFileSync(path.join(project.dir, 'mirror.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(mirror.filter((output) => output.text === 'test body: <secret:apiToken>\n')).toEqual([expect.objectContaining({ target: 'headless' })]);
    // What it prints later, from a timer it started there, never comes back to it.
    expect(mirror.map((output) => output.text)).not.toContain('echo\n');
    expect(cli.stderr).toContain('echo\n');
  });

  it('prints output itself, the write that broke it included, once the interactive reporter throws', () => {
    const broken = CONFIG.replace(
      "reporters: ['list', {",
      `reporters: [{ name: 'broken-view', interactive: true, onEvent(event) { if (event.type === 'output' && event.text.startsWith('test file')) throw new Error('VIEW_BOOM'); } }, {`,
    );
    const cli = runCli({ 'e2e.config.ts': broken, 'tests/print.e2e.ts': TEST }, []);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const lines = cli.stderr.split('\n');
    expect(lines).toContain('e2e: reporter "broken-view" threw on output: VIEW_BOOM; ignoring it for the rest of the run');
    expect(lines).toEqual(expect.arrayContaining(['test file top level: <secret:apiToken>', 'test body: <secret:apiToken>']));
    // The runner prints for it on stderr.
    expect(cli.stdout).not.toContain('test body');
    expect(`${cli.stdout}\n${cli.stderr}`).not.toContain(TOKEN);
  });

  it('prints a test body on stderr without an interactive reporter, leaving stdout alone', () => {
    const cli = runCli({ 'e2e.config.ts': CONFIG, 'tests/print.e2e.ts': TEST }, ['--reporter', 'junit']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stderr.split('\n')).toContain('test body: <secret:apiToken>');
    expect(cli.stdout).toBe('');
    expect(`${cli.stdout}\n${cli.stderr}`).not.toContain(TOKEN);
  });

  it('keeps stdout for the json report and prints user output on stderr', () => {
    const cli = runCli({ 'e2e.config.ts': CONFIG, 'tests/print.e2e.ts': TEST }, ['--reporter', 'json']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ schemaVersion: 'report-1' });
    const lines = cli.stderr.split('\n');
    for (const line of ['config console.log: <secret:apiToken>', 'test file top level: <secret:apiToken>', 'test body: <secret:apiToken>']) {
      expect(lines).toContain(line);
    }
    expect(cli.stderr).not.toContain(TOKEN);
  });

  it('keeps stdout for the json report beside list, whatever the config, a reporter, or a timer prints', () => {
    const cli = runCli({ 'e2e.config.ts': CONFIG, 'tests/print.e2e.ts': TEST }, ['--reporter', 'list,json']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ schemaVersion: 'report-1' });
    const lines = cli.stderr.split('\n');
    for (const line of ['config console.log: <secret:apiToken>', 'reporter onRunFinished: <secret:apiToken>', 'test body: <secret:apiToken>', 'after the run: <secret:apiToken>']) {
      expect(lines).toContain(line);
    }
  });

  it('lets any reporter print a document to stdout from onSummary, redacted', () => {
    const tap = CONFIG.replace("reporters: ['list', {", `reporters: ['list', { name: 'tap', onSummary() { process.stdout.write(\`TAP version 14\\n# \${token}\\n\`); } }, {`);
    const cli = runCli({ 'e2e.config.ts': tap, 'tests/print.e2e.ts': TEST }, ['--reporter', 'junit']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout).toBe('TAP version 14\n# <secret:apiToken>\n');
  });

  it('keeps stdout for the json report whatever another reporter prints there, live or from onSummary', () => {
    const view = `{
    name: 'view',
    interactive: true,
    onEvent(event) { if (event.type === 'test-finished') process.stdout.write('VIEW LINE\\n'); },
    onSummary() { console.log('VIEW SUMMARY'); },
  }, { name: 'sum', onSummary() { console.log(\`SUMMARY LINE: \${token}\`); } }`;
    const config = CONFIG.replace("reporters: ['list', {", `reporters: ['json', ${view}, {`);
    const cli = runCli({ 'e2e.config.ts': config, 'tests/print.e2e.ts': TEST });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ schemaVersion: 'report-1' });
    const lines = cli.stderr.split('\n');
    for (const line of ['VIEW LINE', 'VIEW SUMMARY', 'SUMMARY LINE: <secret:apiToken>']) expect(lines).toContain(line);
    expect(cli.stderr).not.toContain(TOKEN);
  });

  it("prints the json report without waiting for another reporter's onRunFinished", async () => {
    const slow = "{ name: 'slow', onRunFinished: () => new Promise((resolve) => setTimeout(resolve, 3000)) }";
    const project = createProject({ 'e2e.config.ts': CONFIG.replace("reporters: ['list', {", `reporters: ['json', ${slow}, {`), 'tests/print.e2e.ts': TEST });
    projects.push(project);
    const child = spawn(process.execPath, [CLI, 'run'], { cwd: project.dir, env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' } });
    let stdout = '';
    let printedAt: number | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      printedAt ??= Date.now();
      stdout += chunk;
    });
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve));
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ schemaVersion: 'report-1' });
    expect(Date.now() - printedAt!).toBeGreaterThan(2000);
  }, 30_000);

  it('prints one json report however often the config names the reporter', () => {
    const config = `import { json } from 'e2e/reporters';\n${CONFIG.replace("reporters: ['list', {", "reporters: ['json', json(), json(), {")}`;
    const cli = runCli({ 'e2e.config.ts': config, 'tests/print.e2e.ts': TEST });
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ schemaVersion: 'report-1' });
  });

  it('keeps stdout for the json report in an embedded run, and leaves it to user code without one', () => {
    // Once `run` returns, the embedding program's streams are its own again.
    const config = CONFIG.replace(AFTER_RUN, '');
    expect(config).not.toContain('beforeExit');
    const json = runCli({ 'e2e.config.ts': config.replace("reporters: ['list', {", "reporters: ['json', {"), 'tests/print.e2e.ts': TEST }, [], EMBEDDED);
    expect(json.status, json.stdout + json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 'report-1' });
    expect(json.stderr.split('\n')).toContain('config console.log: <secret:apiToken>');

    const none = runCli({ 'e2e.config.ts': config, 'tests/print.e2e.ts': TEST }, [], EMBEDDED);
    expect(none.status, none.stdout + none.stderr).toBe(0);
    expect(none.stdout.split('\n')).toContain('config console.log: <secret:apiToken>');
  });

  it('decodes a string written with an encoding, in the config and a test body', () => {
    const hex = (text: string) => Buffer.from(text).toString('hex');
    const base64 = (text: string) => Buffer.from(text).toString('base64');
    const latin1 = (text: string) => Buffer.from(text).toString('latin1');
    const config = `import { defineEngine } from 'e2e/engine';

process.stdout.write('${hex('config hex\n')}', 'hex');

export default {
  targets: [{ name: 'headless', platform: 'test', engine: defineEngine({ name: 'noop', version: '1', spiVersion: 1 }) }],
  workers: 1,
  secrets: { apiToken: '${TOKEN}' },
};
`;
    const test = `import { test } from 'e2e';

test('prints encoded', () => {
  process.stdout.write('${hex(`test hex: ${TOKEN}\n`)}', 'hex');
  process.stderr.write('${base64('test base64\n')}', 'base64');
  process.stdout.write(${JSON.stringify(latin1('test latin1: café\n'))}, 'latin1');
  process.stdout.write('${hex('test upper hex\n')}', 'HEX');
});
`;
    const cli = runCli({ 'e2e.config.ts': config, 'tests/print.e2e.ts': test }, ['--reporter', 'junit']);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const printed = cli.stderr.split('\n');
    expect(printed.filter((line) => line === 'config hex'), cli.stderr).toHaveLength(2);
    expect(printed).toContain('test hex: <secret:apiToken>');
    expect(printed).toContain('test latin1: café');
    expect(printed).toContain('test upper hex');
    expect(printed).toContain('test base64');
    const output = `${cli.stdout}\n${cli.stderr}`;
    for (const encoded of [hex('config hex\n'), hex(`test hex: ${TOKEN}\n`), base64('test base64\n'), latin1('test latin1: café\n'), hex('test upper hex\n')]) {
      expect(output).not.toContain(encoded);
    }
  });

  it('withholds what a config printed before it failed to load', () => {
    const cli = runCli({ 'e2e.config.ts': BROKEN_CONFIG });
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(cli.status).not.toBe(0);
    expect(output).toContain('config refuses to load');
    expect(output).toContain('withheld');
    expect(output).not.toContain(TOKEN);
  });
});

it('keeps attached project tool output out of the run and report', async () => {
  const builtOutput = '../../dist/run/process-output.js';
  const { withProcessOutput }: typeof import('../../src/run/process-output.ts') = await import(builtOutput);
  const line = 'printed during an attached call';
  const lateLine = 'printed by a tool timer after the attached call';
  const project = createProject({
    'tests/paused.e2e.ts': `import { test } from 'e2e';
test('prints and pauses', async ({ screen }) => {
  process.stdout.write('printed by the test\\n');
  await screen.pause();
});
`,
    'e2e.config.ts': `import { defineTool } from 'e2e/agent';
import { z } from 'zod';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP }],
  agents: { default: { tools: {
    print_line: defineTool({
      inputSchema: z.object({}),
      execute: async () => {
        process.stdout.write(${JSON.stringify(line + '\n')});

        setTimeout(() => {
          process.stdout.write(${JSON.stringify(lateLine + '\n')});
        }, 0);

        return 'printed';
      },
    }, { mutates: false }),
  } } },
};
`,
  });
  const printTool = defineTool({
    inputSchema: z.object({}),
    execute: async () => {
      process.stdout.write(`${line}\n`);

      setTimeout(() => {
        process.stdout.write(`${lateLine}\n`);
      }, 0);

      return 'printed';
    },
  }, { mutates: false });
  let output = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });

  try {
    for (const worker of ['in-process', 'child process']) {
      output = '';
      const outcome = await withProcessOutput(new SecretLedger(), (processOutput) => {
        const runOptions: Partial<RunOptions> = {
          quiet: false,
          processOutput,
          hold: {
            steps: false,
            ask: async (step, { attach }) => {
              const attached = await attach(step.attachId);
              const reply = await attached.call('print_line', {});
              expect(reply).toEqual({ content: [{ type: 'text', text: 'printed' }] });

              await vi.waitFor(() => expect(output, worker).toContain(lateLine));
            },
          },
        };

        if (worker === 'child process') {
          return runExistingWithConfigFile(project, { runOptions });
        }

        return runExisting(project, {
          config: { agents: { default: { tools: { print_line: printTool } } } },
          runOptions,
        });
      });

      expect(outcome.exitCode, worker).toBe(0);
      expect(output, worker).toContain('printed by the test');
      expect(output, worker).not.toContain(line);
      expect(readFileSync(path.join(project.dir, '.e2e/report.json'), 'utf8'), worker).not.toContain(line);
    }
  } finally {
    stdout.mockRestore();
    project.cleanup();
  }
});
