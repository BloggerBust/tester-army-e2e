/** The `ctrf` reporter through the built CLI: `--reporter ctrf` writes a CTRF 0.3.0 file whose counts agree with `junit.xml`. */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidCtrf } from '../helpers/ctrf-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const KEY = 'e2e-inc.e2e';
const projects: FixtureProject[] = [];

type Json = Record<string, any>;

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

/** A config on the fake engine, with `app` as the target's app. */
function fakeConfig(app = 'FAKE_APP'): string {
  return `import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({}).engine, app: ${app} }],
  workers: 1,
  cache: 'off',
} satisfies E2EConfig;
`;
}

/** Writes a project and runs `e2e run` in it with `args`. */
function run(files: Record<string, string>, args: readonly string[]) {
  const project = createProject(files);
  projects.push(project);
  const result = spawnSync(process.execPath, [CLI, 'run', ...args], {
    cwd: project.dir,
    env: { ...process.env, CI: '', CI_PROJECT_DIR: '', GITHUB_ACTIONS: '', APP_URL: '', NO_COLOR: '1', E2E_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
    timeout: 90_000,
  });
  expect(result.error).toBeUndefined();
  const read = (file: string): string => readFileSync(path.join(project.dir, '.e2e', file), 'utf8');
  return { project, exitCode: result.status, output: `${result.stdout}\n${result.stderr}`, read };
}

/** `name="value"` attributes of the first `<tag ...>` in `xml`, as numbers. */
function counts(xml: string, tag: string): Record<string, number> {
  const match = new RegExp(`<${tag} ([^>]*)>`).exec(xml);
  if (match === null) throw new Error(`no <${tag}> in:\n${xml}`);
  return Object.fromEntries([...match[1]!.matchAll(/(\w+)="([\d.]+)"/g)].map((m) => [m[1]!, Number(m[2])]));
}

const SUITE = `import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'e2e';
test('passes', () => {});
test('passes on retry', { retries: 1 }, () => {
  const marker = new URL('./first-attempt', import.meta.url);
  if (!existsSync(marker)) {
    writeFileSync(marker, '');
    throw new Error('retry this test');
  }
});
test('fails', () => {
  throw new Error('the cart is empty');
});
test('times out', { timeout: 300 }, async () => {
  await new Promise(() => {});
});
test.skip('is skipped', () => {});
`;

const TEARDOWN = `import { test } from 'e2e';
test.afterAll(() => {
  throw new Error('teardown broke');
});
test('passes before a broken teardown', () => {});
`;

describe('ctrf reporter at the process boundary', () => {
  it('writes ctrf.json beside junit.xml, keeps run errors out of the tests, and agrees with the JUnit counts', () => {
    const { exitCode, output, read } = run(
      { 'e2e.config.ts': fakeConfig(), 'tests/cart.e2e.ts': SUITE, 'tests/teardown.e2e.ts': TEARDOWN },
      ['--reporter', 'list,junit,ctrf'],
    );
    expect(exitCode, output).toBe(1);
    expect(output).toMatch(/CTRF\s+\.e2e[/\\]ctrf\.json/u);

    const document = JSON.parse(read('ctrf.json')) as Json;
    assertValidCtrf(document);
    const report = JSON.parse(read('report.json')) as Json;
    expect(document.reportId).toBe(report.run.id);

    const byTitle = new Map((document.results.tests as Json[]).map((test) => [test.name.split(' > ').at(-1).replace(' [fake]', ''), test]));
    expect(byTitle.get('passes')).toMatchObject({ status: 'passed', rawStatus: 'passed' });
    expect(byTitle.get('passes on retry')).toMatchObject({ status: 'passed', rawStatus: 'flaky', flaky: true, retries: 1 });
    expect(byTitle.get('passes on retry')!.retryAttempts[0]).toMatchObject({ attempt: 1, status: 'failed', message: expect.stringContaining('retry this test') });
    expect(byTitle.get('fails')).toMatchObject({ status: 'failed', rawStatus: 'failed', message: expect.stringContaining('the cart is empty') });
    expect(byTitle.get('times out')).toMatchObject({ status: 'failed', rawStatus: 'timed-out' });
    expect(byTitle.get('is skipped')).toMatchObject({ status: 'skipped', duration: 0 });
    expect(byTitle.get('passes before a broken teardown')).toMatchObject({ status: 'passed' });

    // The teardown failure is a run error: listed once, never a test.
    expect(document.results.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/^HOOK_FAILED \(afterAll\): /u), extra: { [KEY]: expect.objectContaining({ code: 'HOOK_FAILED', phase: 'afterAll' }) } })]);
    expect(document.extra[KEY]).toMatchObject({ runId: report.run.id, exitCode: 1 });

    // The relation to junit.xml: JUnit adds a `run` suite case per run error; CTRF does not.
    const junit = read('junit.xml');
    const totals = counts(junit, 'testsuites');
    const runSuite = /<testsuite name="run" ([^>]*)>/.test(junit) ? counts(junit, 'testsuite name="run"') : { tests: 0, errors: 0 };
    expect(runSuite.tests).toBe(document.results.errors.length);
    expect(document.results.summary).toMatchObject({
      tests: totals.tests! - runSuite.tests!,
      failed: totals.failures! + totals.errors! - runSuite.errors!,
      skipped: totals.skipped,
      other: 0,
      flaky: 1,
      suites: 2,
    });
  });

  it('writes no ctrf.json, like junit.xml, for a run that stopped before its tests, and the exit code says it failed', () => {
    const { project, exitCode, output } = run(
      {
        'e2e.config.ts': fakeConfig(`{ ...FAKE_APP, command: { executable: process.execPath, args: ['-e', 'process.exit(7)'] } }`),
        'tests/cart.e2e.ts': `import { test } from 'e2e';\ntest('never runs', () => {});\n`,
      },
      ['--reporter', 'list,junit,ctrf'],
    );
    expect(exitCode, output).toBe(3);
    expect(output).toContain('APP_UNREACHABLE');
    for (const file of ['report.json', 'junit.xml', 'ctrf.json']) expect(existsSync(path.join(project.dir, '.e2e', file)), file).toBe(false);
  });

  it('maps a test the run stopped to other, which JUnit counts as skipped', () => {
    const { exitCode, output, read } = run(
      {
        'e2e.config.ts': fakeConfig(),
        'tests/slow.e2e.ts': `import { test } from 'e2e';\ntest('skipped on purpose', { skip: true }, () => {});\ntest('outlives the run', { timeout: 60_000 }, async () => {\n  await new Promise((resolve) => setTimeout(resolve, 30_000));\n});\n`,
      },
      ['--reporter', 'list,junit,ctrf', '--max-duration', '1500'],
    );
    expect(exitCode, output).toBe(1);
    const document = JSON.parse(read('ctrf.json')) as Json;
    assertValidCtrf(document);
    const stopped = (document.results.tests as Json[]).find((test) => test.name.includes('outlives the run'));
    expect(stopped).toMatchObject({ status: 'other', rawStatus: 'interrupted', message: expect.stringMatching(/^interrupted: /u) });
    const totals = counts(read('junit.xml'), 'testsuites');
    // The time limit is a run error: JUnit adds a `run` suite case for it, CTRF lists it in results.errors.
    expect(document.results.errors).toEqual([expect.objectContaining({ extra: { 'e2e-inc.e2e': expect.objectContaining({ code: 'RUN_TIMEOUT' }) } })]);
    expect(document.results.summary).toMatchObject({ other: 1, skipped: totals.skipped! - 1, tests: totals.tests! - document.results.errors.length });
  });

  it('keeps ctrf off by default (a guard, also true on main): a config without reporters writes no ctrf.json', () => {
    const { project, exitCode } = run({ 'e2e.config.ts': fakeConfig(), 'tests/ok.e2e.ts': `import { test } from 'e2e';\ntest('ok', () => {});\n` }, []);
    expect(exitCode).toBe(0);
    expect(existsSync(path.join(project.dir, '.e2e', 'report.json'))).toBe(true);
    expect(existsSync(path.join(project.dir, '.e2e', 'ctrf.json'))).toBe(false);
  });
});
