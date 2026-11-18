/** Dot progress and user output keep their own formatting through the built CLI. */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuiltinReporter } from '../../src/run-types.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** Runs the built CLI, or the public SDK for a quiet run, in a separate process. */
function runReporters(reporters: readonly BuiltinReporter[], outputAtEnd = '', options: {
  readonly source?: string;
  readonly args?: readonly string[];
  readonly exitCode?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly quiet?: boolean;
} = {}) {
  const project = createProject({
    'e2e.config.ts': `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',
  reporters: [
    ...${JSON.stringify(reporters)},
    {
      name: 'user-output',
      onEvent(event) {
        if (event.type === 'run-finished') { ${outputAtEnd} }
      },
    },
  ],
} satisfies E2EConfig;
`,
    'tests/pass.e2e.ts': options.source ?? `import { test } from 'e2e';
test('passes', async ({ app }) => { await app.open(); });
`,
  });
  projects.push(project);
  const args = options.quiet === true
    ? ['--input-type=module', '-e', "import { run } from 'e2e/runner'; process.exitCode = (await run({ cwd: process.cwd() })).exitCode;"]
    : [CLI, 'run', ...(options.args ?? [])];
  const result = spawnSync(process.execPath, args, {
    cwd: project.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1', ...options.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(options.exitCode ?? 0);
  return { stdout: result.stdout, stderr: result.stderr };
}

describe('dot reporter output at the process boundary', () => {
  it.each(['stdout', 'stderr'] as const)('ends unfinished user %s on its own line', (stream) => {
    const result = runReporters(['dot'], `process.${stream}.write('tail');`);
    expect(result.stdout).toMatch(/^\.$/mu);
    expect(result.stdout).toMatch(/Tests\s+1 passed/u);
    if (stream === 'stdout') expect(result.stdout).toContain('\ntail\n');
    expect(result.stderr).toBe(stream === 'stderr' ? 'tail\n' : '');
  });

  it('ends unfinished user output on both destinations', () => {
    const result = runReporters(['dot'], `process.stdout.write('stdout tail'); process.stderr.write('stderr tail');`);
    expect(result.stdout).toContain('\nstdout tail\n');
    expect(result.stderr).toBe('stderr tail\n');
  });

  it('ends user output on stderr while keeping JSON stdout valid', () => {
    const result = runReporters(['dot', 'json'], `process.stdout.write('stdout tail'); process.stderr.write('stderr tail');`);
    assertValidReport(JSON.parse(result.stdout));
    expect(result.stderr).toMatch(/^\.$/mu);
    expect(result.stderr).toMatch(/Tests\s+1 passed/u);
    expect(result.stderr).toContain('\nstdout tailstderr tail\n');
  });

  it('rejects list and dot together in config', () => {
    const result = runReporters(['list', 'dot'], '', { exitCode: 2 });
    expect(result.stdout + result.stderr).toContain('INVALID_CONFIG');
    expect(result.stdout + result.stderr).toMatch(/list.*dot|dot.*list/u);
  });

  it('rejects list and dot together on the command line', () => {
    const result = runReporters(['dot'], '', { args: ['--reporter', 'list,dot'], exitCode: 2 });
    expect(result.stdout + result.stderr).toContain('INVALID_CONFIG');
    expect(result.stdout + result.stderr).toMatch(/list.*dot|dot.*list/u);
  });

  it('prints genuine runner output without adding list headings', () => {
    const result = runReporters(['dot'], `process.stdout.write('runner log\\n');`);
    const output = result.stdout + result.stderr;
    expect(output).toContain('\nrunner log\n');
    expect(output).not.toContain('stdout | runner');
    expect(output).not.toContain('stderr | runner');
  });

  it.each([
    { label: 'dot', reporters: ['dot'] as const },
    { label: 'dot,json', reporters: ['dot', 'json'] as const },
  ])('reports failure details and counts with $label', ({ reporters }) => {
    const result = runReporters(reporters, '', {
      source: `import { expect, test } from 'e2e';
test('passes', () => {});
test.skip('skips', () => {});
test('compares the wrong number', () => { expect(1).toBe(2); });
`,
      exitCode: 1,
    });
    const json = reporters.some((id) => id === 'json');
    const human = json ? result.stderr : result.stdout;
    if (json) assertValidReport(JSON.parse(result.stdout));
    else expect(result.stderr).toBe('');
    expect(human).toMatch(/^ RUN /mu);
    expect(human).toContain('Failed Tests');
    expect(human).toContain('compares the wrong number');
    expect(human).toContain('expected 1 to be 2');
    expect(human).toMatch(/tests\/pass\.e2e\.ts:\d+/u);
    expect(human).toMatch(/Tests\s+1 failed.*1 passed.*1 skipped/u);
  });

  it('prints a collection error once with dot and keeps JSON parseable', () => {
    const result = runReporters(['dot', 'json'], '', {
      source: "import { test } from 'e2e';\ntest('broken', () => { const text = 'unterminated; });\n",
      exitCode: 2,
    });
    assertValidReport(JSON.parse(result.stdout));
    expect(result.stderr).toContain('COLLECTION_ERROR');
    expect(result.stderr).toContain('Unterminated string');
    expect(result.stderr.split('failed to collect tests/pass.e2e.ts')).toHaveLength(2);
    expect(result.stderr).toMatch(/Errors\s+1 error/u);
  });

  it('keeps SDK runs silent even when a test fails', () => {
    const result = runReporters(['dot'], '', {
      source: "import { expect, test } from 'e2e';\ntest('fails', () => { expect(1).toBe(2); });\n",
      quiet: true,
      exitCode: 1,
    });
    expect(result).toEqual({ stdout: '', stderr: '' });
  });

  it('keeps the JSON report when the SDK suppresses dot output', () => {
    const result = runReporters(['dot', 'json'], '', { quiet: true });
    assertValidReport(JSON.parse(result.stdout));
    expect(result.stderr).toBe('');
  });

  it('honors NO_COLOR for dots and the shared terminal report', () => {
    const result = runReporters(['dot'], '', { env: { NO_COLOR: '1', FORCE_COLOR: '1' } });
    expect(result.stdout).toBe(stripVTControlCharacters(result.stdout));
    expect(result.stdout).toMatch(/^\.$/mu);
    expect(result.stdout).toMatch(/Tests\s+1 passed/u);
  });
});
