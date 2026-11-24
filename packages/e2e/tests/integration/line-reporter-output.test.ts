/** The `line` reporter through the built CLI, where no terminal is attached: one row per result. */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Report1Document } from '../../src/report/build.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** A config on the fake engine with `extra` config keys, after `head`. */
function fakeConfig(extra = '', head = ''): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
${head}
export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: FAKE_APP }],
  workers: 1,
  cache: 'off',${extra}
} satisfies E2EConfig;
`;
}

/** Writes a project and runs one CLI command in it. */
function cli(files: Record<string, string>, args: readonly string[]) {
  const project = createProject(files);
  projects.push(project);
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project.dir,
    env: { ...process.env, CI: '', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return { project, exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The progress rows among `text`'s lines. */
const rowsOf = (text: string): string[] => text.split('\n').filter((line) => /^\[\d+\/[\d?]+\] /u.test(line));

describe('line reporter output at the process boundary', () => {
  it('prints one counted row per selected result, the final one of a retried test', () => {
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig("\n  reporters: ['line'],"),
        'tests/line.e2e.ts': `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('selected pass', () => {});
test('selected retry', { retries: 1 }, () => {
  const marker = new URL('./first-attempt', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('retry this test');
  }
});
test.skip('selected skip', () => {});
test('left out', () => {});
`,
      },
      ['run', '--grep', 'selected'],
    );
    expect(exitCode, stdout).toBe(0);
    expect(rowsOf(stdout)).toEqual([
      '[1/3] |fake| tests/line.e2e.ts > selected skip (skipped)',
      '[2/3] |fake| tests/line.e2e.ts > selected pass (passed)',
      '[3/3] |fake| tests/line.e2e.ts > selected retry (flaky)',
    ]);
    expect(stdout).not.toContain('left out');
    expect(stdout).toMatch(/Tests\s+1 passed.*1 flaky.*1 skipped \(3\)/u);
  });

  it('prints each failure as its result arrives, and beside json closes on stderr with the trace pages', () => {
    const { project, exitCode, stdout, stderr } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/line.e2e.ts': `import { expect, test } from 'e2e';
test('wrong', () => {
  console.log('test log');
  expect(1).toBe(2);
});
test('later', () => {
  console.log('later test log');
  expect(3).toBe(4);
});
`,
      },
      ['run', '--reporter', 'line,json'],
    );
    expect(exitCode, stderr).toBe(1);
    const report = JSON.parse(stdout) as Report1Document;
    assertValidReport(report);
    expect(report.run.results.map((result) => [result.titlePath, result.status])).toEqual([[['wrong'], 'failed'], [['later'], 'failed']]);

    const [first, second] = rowsOf(stderr);
    expect([first, second]).toEqual([
      '[1/2] |fake| tests/line.e2e.ts > wrong (failed)',
      '[2/2] |fake| tests/line.e2e.ts > later (failed)',
    ]);
    const laterLog = stderr.indexOf('\nlater test log\n');
    const closing = stderr.search(/^ +Failed +×/mu);
    const firstBlock = stderr.slice(stderr.indexOf(first!), laterLog);
    const secondBlock = stderr.slice(stderr.indexOf(second!), closing);
    expect(firstBlock).toMatch(/^ FAIL {2}\|fake\| tests\/line\.e2e\.ts > wrong$/mu);
    expect(firstBlock).toContain('ASSERTION_FAILED: expected 1 to be 2');
    expect(firstBlock).toMatch(/\d+\|\s+expect\(1\)\.toBe\(2\)/u);
    expect(secondBlock).toMatch(/^ FAIL {2}\|fake\| tests\/line\.e2e\.ts > later$/mu);
    expect(secondBlock).toContain('ASSERTION_FAILED: expected 3 to be 4');
    expect(stderr).not.toContain('Failed Tests');
    expect(stderr.match(/^ FAIL /gmu)).toHaveLength(2);

    const traces = [...stderr.slice(closing).matchAll(/^ *(?:Failed +)?× \|fake\| tests\/line\.e2e\.ts:\d+ > (.+)\n +ASSERTION_FAILED: [^\n]+\n +trace (\S+\/trace\.md)$/gmu)];
    expect(traces.map(([, title]) => title)).toEqual(['wrong', 'later']);
    for (const [, title, trace] of traces) expect(readFileSync(path.join(project.dir, trace!), 'utf8')).toMatch(`# ✗ ${title}\n`);
  });

  it('counts against ? when the run fails before it knows its tests', () => {
    const { exitCode, stdout, stderr } = cli(
      {
        'e2e.config.ts': `import { defineEngine } from 'e2e/engine';
const engine = defineEngine({
  name: 'fake', version: '1.0.0', spiVersion: 1,
  async prepare() { throw new Error('fixture preparation failed'); },
});
export default { targets: [{ name: 'fake', platform: 'fake', engine }] };
`,
        'tests/prepare.e2e.ts': `import { test } from 'e2e';
test.skip('registered skip', () => {});
test('scheduled', () => {});
`,
      },
      ['run', '--reporter', 'line,json'],
    );
    expect(exitCode, stderr).toBe(3);
    assertValidReport(JSON.parse(stdout));
    expect(rowsOf(stderr)).toEqual(['[1/?] |fake| tests/prepare.e2e.ts > registered skip (skipped)']);
    expect(stderr).toContain('fixture preparation failed');
  });

  it('prints a collection error once, with no row', () => {
    const { exitCode, stdout } = cli(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/broken.e2e.ts': "import { test } from 'e2e';\ntest('broken', async () => { const text = 'unterminated; });\n",
      },
      ['run', '--reporter', 'line'],
    );
    expect(exitCode).toBe(2);
    expect(stdout).toContain('Run Errors');
    expect(stdout.split('failed to collect tests/broken.e2e.ts')).toHaveLength(2);
    expect(rowsOf(stdout)).toEqual([]);
  });

  it.each(['list', 'dot'])('refuses to show the run beside %s', (other) => {
    const { exitCode, stdout, stderr } = cli({ 'e2e.config.ts': fakeConfig(), 'tests/pass.e2e.ts': "import { test } from 'e2e';\ntest('passes', () => {});\n" }, ['run', '--reporter', `${other},line`]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain(`reporters "${other}" and "line" are all interactive`);
  });

  it('shows an exploration as its one test', () => {
    const { exitCode, stdout, stderr } = cli(
      {
        'e2e.config.ts': fakeConfig(
          "\n  agents: { default: { model: installFakeModel(() => extracted({ decision: 'finish', title: '', instruction: '', summary: 'Finished' })) } },",
          "import { extracted, installFakeModel } from '../../helpers/fake-model.ts';",
        ),
      },
      ['explore', 'Check the app', '--config', 'e2e.config.ts', '--reporter', 'line'],
    );
    expect(exitCode, stdout + stderr).toBe(0);
    expect(rowsOf(stdout)).toEqual(['[1/1] |fake| explore > Check the app (passed)']);
    expect(stdout).toMatch(/Explored {2}Check the app/u);
  });
});
