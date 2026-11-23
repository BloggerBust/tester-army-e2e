/**
 * `NODE_DEBUG` naming `child_process` makes Node print the environment of
 * every process the run starts, keys included, and `net` prints the options
 * of each `http.request`, its `Authorization` header included. Node decides
 * this once at startup, so the run cannot turn it off: it says so once, on
 * stderr, and runs. Through the built CLI with two workers, since each
 * worker is a Node process of its own. The names are matched as Node matches
 * them: comma-separated, in any case, with `*` as a wildcard.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

const CONFIG = `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 2,
  cache: 'off',
} satisfies E2EConfig;
`;

const suite = (title: string) => `import { test } from 'e2e';\ntest('${title}', async ({ app }) => {\n  await app.open();\n});\n`;

/** One `e2e run` of two tests on two workers with `NODE_DEBUG` set to `value`, or unset: its exit code and the warnings e2e printed. */
function runWith(value: string | undefined): { exitCode: number | null; warnings: string[] } {
  const project = createProject({ 'e2e.config.ts': CONFIG, 'tests/a.e2e.ts': suite('a'), 'tests/b.e2e.ts': suite('b') });
  projects.push(project);
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '', NO_COLOR: '1', E2E_TELEMETRY_DISABLED: '1' };
  delete env['NODE_DEBUG'];
  if (value !== undefined) env['NODE_DEBUG'] = value;
  const result = spawnSync(process.execPath, [CLI, 'run'], { cwd: project.dir, env, encoding: 'utf8', timeout: 90_000, maxBuffer: 256 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  // Node's own debug lines start with the section name; e2e's start with `e2e:`.
  const warnings = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.startsWith('e2e:') && line.includes('NODE_DEBUG'));
  return { exitCode: result.status, warnings };
}

/** The `e2e:` lines about NODE_DEBUG a process printed. */
function warningsIn(result: { stdout: string; stderr: string }): string[] {
  return `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.startsWith('e2e:') && line.includes('NODE_DEBUG'));
}

/** `args` run by Node in a fresh project, with `NODE_DEBUG` set to `value` or unset, and empty stdin: the warnings it printed. */
function warningsOf(args: string[], value: string | undefined, extraEnv: NodeJS.ProcessEnv = {}): string[] {
  const project = createProject({ 'tests/none.e2e.ts': '' });
  projects.push(project);
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, CI: '', NO_COLOR: '1', E2E_TELEMETRY_DISABLED: '1' };
  delete env['NODE_DEBUG'];
  if (value !== undefined) env['NODE_DEBUG'] = value;
  const result = spawnSync(process.execPath, args, { cwd: project.dir, env, input: '', encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  return warningsIn(result);
}

describe('NODE_DEBUG outside e2e run', () => {
  // The server reads MCP messages from stdin and stops when it closes.
  it.each([['child_process', 1], [undefined, 0]] as const)('e2e mcp warns %s: %i time(s)', (value, count) => {
    const warnings = warningsOf([CLI, 'mcp'], value);
    expect(warnings).toHaveLength(count);
    if (count > 0) expect(warnings[0]).toContain(`NODE_DEBUG=${String(value)}`);
  });

  const openHost = ['--input-type=module', '-e', "import { openHost } from 'e2e/runner'; await openHost({ cwd: process.cwd() }).then(host => host.close(), () => undefined);"];
  // No config in the directory: the host refuses to open, after it has warned.
  it.each([['child_process', 1], [undefined, 0]] as const)('openHost warns %s: %i time(s)', (value, count) => {
    const warnings = warningsOf(openHost, value);
    expect(warnings).toHaveLength(count);
    if (count > 0) expect(warnings[0]).toContain(`NODE_DEBUG=${String(value)}`);
  });

  it('redacts a known provider key in the warning openHost writes to stderr', () => {
    const key = 'synthetic-warning-marker-for-redaction';
    const warnings = warningsOf(openHost, 'net,' + key, { OPENAI_API_KEY: key });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NODE_DEBUG=net,<secret:OPENAI_API_KEY>');
    expect(warnings[0]).not.toContain(key);
  });
});

describe('NODE_DEBUG that prints credentials', () => {
  it.each(['child_process', 'net', 'CHILD_PROCESS', 'http,child_process', 'chi*', '*'])('warns once and still runs with NODE_DEBUG=%s', (value) => {
    const { exitCode, warnings } = runWith(value);
    expect(exitCode).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`NODE_DEBUG=${value}`);
    expect(warnings[0]).toMatch(/environment|credential|key/i);
  });

  it.each([undefined, '', 'http', 'fetch,undici', ' child_process', 'child-process', 'n*t2'])('says nothing with NODE_DEBUG=%s', (value) => {
    const { exitCode, warnings } = runWith(value);
    expect(exitCode).toBe(0);
    expect(warnings).toEqual([]);
  });
});
