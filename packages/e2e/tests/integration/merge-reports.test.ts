import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resultSegment } from '@e2e-dev/core/lib/run/artifacts';
import type { Report1Document } from '../../src/report/build.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const projects: FixtureProject[] = [];

afterEach(() => {
  for (const fixture of projects.splice(0)) fixture.cleanup();
});

function project() {
  const fixture = createProject({
    'e2e.config.ts': `import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';
export default {
  targets: [{ name: 'fake', platform: 'fake', engine: createFakeEngine({ state: true }).engine, app: FAKE_APP }],
  workers: 1, cache: 'off',
  reporters: ['markdown', { name: 'finished', onRunFinished(run) {
    console.log('finished report:', run.report.run.summary.selected);
  } }],
};`,
    'tests/shop.e2e.ts': `import { test } from 'e2e';
test.setup('sign in', { sessions: ['member'] }, async ({ app, session }) => {
  await app.open();
  if (process.env.FAIL_SETUP) throw new Error('sign in failed');
  await session.save('member');
});
test('cart', { session: 'member' }, async ({ app }) => {
  await app.open();
  if (process.env.FAIL_CART) throw new Error('cart failed');
});
test('checkout', { session: 'member' }, async ({ app }) => {
  await app.open();
  if (process.env.FAIL_CHECKOUT) throw new Error('checkout failed');
});`,
  });
  projects.push(fixture);
  return fixture;
}

function cli(fixture: FixtureProject, args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: fixture.dir,
    env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', FAIL_SETUP: '', FAIL_CART: '', FAIL_CHECKOUT: '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function report(fixture: FixtureProject, output: string, file = 'report.json') {
  const document: unknown = JSON.parse(readFileSync(path.join(fixture.dir, output, file), 'utf8'));
  assertValidReport(document);
  return (document as Report1Document).run;
}

function shard(fixture: FixtureProject, index: number, env: NodeJS.ProcessEnv = {}) {
  return cli(fixture, ['run', '--shard', `${index}/2`, '--output', `shard-${index}`, '--repeat-each', '2', '--trace', 'on'], env);
}

it('merges real shard runs and uses the merged report for a whole-run rerun', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2, { FAIL_CHECKOUT: '1' }).status).toBe(1);
  const merged = cli(fixture, ['merge-reports', 'shard-2', 'shard-1', '--output', 'merged', '--reporter', 'junit']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(merged.stdout).toContain('finished report: 5');
  expect(existsSync(path.join(fixture.dir, 'merged/junit.xml'))).toBe(true);
  if (process.platform !== 'win32') {
    expect(statSync(path.join(fixture.dir, 'merged')).mode).toBe(statSync(path.join(fixture.dir, 'shard-1')).mode);
  }
  expect(existsSync(path.join(fixture.dir, 'merged/summary.md'))).toBe(false);
  const run = report(fixture, 'merged');
  expect(run.shard).toBeUndefined();
  expect(run.summary).toMatchObject({ passed: 3, failed: 2, flaky: 0 });
  expect(run.results.filter((row) => row.kind === 'setup')).toHaveLength(1);
  const rerun = cli(fixture, ['run', '--last-failed', '--output', 'merged']);
  expect(rerun.status, rerun.stderr).toBe(0);
  expect(report(fixture, 'merged').results.filter((row) => row.selected).map((row) => row.titlePath.at(-1)).toSorted()).toEqual(['checkout', 'sign in']);
  const history = report(fixture, 'merged', 'report-with-reruns.json');
  expect(run.merge).toMatchObject({
    shards: [
      { index: 1, status: 'passed', exitCode: 0 },
      { index: 2, status: 'failed', exitCode: 1 },
    ],
  });
  expect(run.merge!.shardDurationMs).toBeGreaterThanOrEqual(0);
  expect(history.merge).toEqual(run.merge);
}, 60_000);

it('keeps both shared setup executions and links each shard’s local evidence', () => {
  const fixture = project();
  expect(shard(fixture, 1, { FAIL_SETUP: '1' }).status).toBe(1);
  expect(shard(fixture, 2).status).toBe(0);
  const artifactPath = 'shared/setup.log';
  for (const index of [1, 2]) {
    const directory = path.join(fixture.dir, `shard-${index}`);
    const run = report(fixture, `shard-${index}`);
    const setup = run.results.find((row) => row.kind === 'setup' && row.selected)!;
    const attempt = setup.attempts[0]!;
    const content = `login in shard ${index}`;
    attempt.artifacts = [...attempt.artifacts, {
      id: 'sign-in-log', kind: 'log', mediaType: 'text/plain', redaction: 'complete',
      producer: { kind: 'attempt' }, path: artifactPath,
      size: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'),
    }];
    mkdirSync(path.join(directory, 'results/shared'), { recursive: true });
    writeFileSync(path.join(directory, 'results', artifactPath), content);
    if (index === 2) run.project.configDigest = 'f'.repeat(64);
    assertValidReport({ schemaVersion: 'report-1', run });
    writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 'report-1', run }));
  }
  const merged = cli(fixture, ['merge-reports', 'shard-2', 'shard-1', '--output', 'merged', '--reporter', 'json']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(merged.stderr).toContain('shard 2 has a different config digest');
  // Configured reporters may write, while stdout still contains just JSON.
  const run = report(fixture, 'merged');
  expect(JSON.parse(merged.stdout).run.id).toBe(run.id);
  const setups = run.results.filter((row) => row.kind === 'setup');
  expect(setups).toHaveLength(1);
  expect(setups[0]?.status).toBe('failed');
  expect(setups[0]?.attempts.map((attempt) => [attempt.shard, attempt.status])).toEqual([[1, 'failed'], [2, 'passed']]);
  const root = path.join(fixture.dir, 'merged/results');
  const trace = readFileSync(path.join(root, resultSegment(setups[0]!), 'trace.md'), 'utf8');
  for (const index of [1, 2]) {
    expect(trace).toContain(`../shard-${index}/${artifactPath}`);
    expect(trace).toContain(`\`merged/results/shard-${index}/${artifactPath}\``);
    expect(readFileSync(path.join(root, `shard-${index}`, artifactPath), 'utf8')).toBe(`login in shard ${index}`);
  }
  // Same-length replacement must still fail the artifact digest check.
  writeFileSync(path.join(fixture.dir, 'shard-1/results', artifactPath), 'login in shard 2');
  const stale = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'stale']);
  expect(stale.status).toBe(2);
  expect(stale.stderr).toContain('does not match its recorded size or digest');
  expect(existsSync(path.join(fixture.dir, 'stale'))).toBe(false);
  rmSync(path.join(fixture.dir, 'shard-1/results', artifactPath));
  const missing = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'missing']);
  expect(missing.status).toBe(2);
  expect(missing.stderr).toContain('artifact "shared/setup.log" is missing from shard 1');
  expect(existsSync(path.join(fixture.dir, 'missing'))).toBe(false);
  // A rerun plus the merged directory alone must keep the old evidence.
  expect(cli(fixture, ['run', '--last-failed', '--output', 'merged']).status).toBe(0);
  for (const index of [1, 2]) expect(existsSync(path.join(root, `shard-${index}`, artifactPath))).toBe(true);
}, 60_000);

it('prefers a shard’s folded rerun and preserves results owned by the other shard', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(cli(fixture, ['run', '--shard', '2/2', '--output', 'shard-2', '--repeat-each', '2'], { FAIL_CHECKOUT: '1' }).status).toBe(1);
  const failedResult = report(fixture, 'shard-2').results.find((row) => row.selected && row.titlePath.at(-1) === 'checkout')!;
  const inputTrace = path.join(fixture.dir, 'shard-2/results', resultSegment(failedResult), 'trace.md');
  expect(existsSync(inputTrace)).toBe(true);
  expect(cli(fixture, ['run', '--last-failed', '--output', 'shard-2']).status).toBe(0);
  expect(existsSync(inputTrace)).toBe(false);
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(0);
  const run = report(fixture, 'merged');
  expect(run.results.filter((row) => row.selected && row.kind === 'test').map((row) => [
    row.titlePath.at(-1), row.repeat, row.status, row.attempts.length,
  ])).toEqual([['cart', 0, 'passed', 1], ['cart', 1, 'passed', 1], ['checkout', 0, 'flaky', 3]]);
  const checkout = run.results.find((row) => row.titlePath.at(-1) === 'checkout')!;
  const trace = path.join(fixture.dir, 'merged/results', resultSegment(checkout), 'trace.md');
  expect(existsSync(trace)).toBe(true);
  expect(readFileSync(trace, 'utf8')).toContain('checkout failed');
}, 60_000);

it('refuses a live-only reporter and refuses artifacts that resolve outside a shard', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  writeFileSync(path.join(fixture.dir, 'live.config.mjs'), 'export default { reporters: [{ name: "live", onEvent() {} }] };');
  const args = ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged'];
  const live = cli(fixture, [...args, '--config', 'live.config.mjs']);
  expect(live.status).toBe(2);
  expect(live.stderr).toContain('reporter "live" needs live events');
  const run = report(fixture, 'shard-1');
  const attempt = run.results.find((row) => row.selected)!.attempts[0]!;
  const outside = path.join(fixture.dir, 'e2e.config.ts');
  const content = readFileSync(outside);
  attempt.artifacts = [...attempt.artifacts, {
    id: 'external', kind: 'log', mediaType: 'text/plain', redaction: 'complete',
    producer: { kind: 'attempt' }, path: 'external.log',
    size: content.length, sha256: createHash('sha256').update(content).digest('hex'),
  }];
  const directory = path.join(fixture.dir, 'shard-1');
  symlinkSync(outside, path.join(directory, 'results', 'external.log'));
  writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 'report-1', run }));
  const malformedArtifact = cli(fixture, args);
  expect(malformedArtifact.status).toBe(2);
  expect(malformedArtifact.stderr).toContain('must be a file inside its results directory');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
  expect(readdirSync(fixture.dir).some((entry) => entry.startsWith('.e2e-merge-'))).toBe(false);
}, 60_000);

it('redacts a merge config secret in config output and reporter errors', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const value = 'fake-merge-secret-89617+case';
  mkdirSync(path.join(fixture.dir, 'ci'));
  writeFileSync(path.join(fixture.dir, 'ci/publish.config.mjs'), `
const value = process.env.MERGE_FIXTURE_SECRET;
const login = process.env.MERGE_FIXTURE_PASSWORD;
console.log(value, login);
export default { credentials: { account: { password: login } }, secrets: { publishing: value }, reporters: [{
  name: 'publisher', onRunFinished(run) { console.log('project root:', run.projectRoot); throw new Error(value); },
}] };
`);
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', path.join(fixture.dir, 'merged'), '--config', 'ci/publish.config.mjs'], {
    MERGE_FIXTURE_SECRET: value,
    MERGE_FIXTURE_PASSWORD: 'fixture-password-31272',
    E2E_USER_ACCOUNT_USERNAME: undefined, E2E_USER_ACCOUNT_PASSWORD: undefined,
  });
  expect(merged.status).toBe(0);
  expect((merged.stdout + merged.stderr).includes('fixture-password-31272')).toBe(false);
  expect(merged.stdout.trimEnd().split('\n')).toContain(`project root: ${fixture.dir}`);
  expect(merged.stderr.includes('reporter "publisher" failed: <secret:publishing>')).toBe(true);
  for (const representation of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
    expect((merged.stdout + merged.stderr).includes(representation)).toBe(false);
    expect(readFileSync(path.join(fixture.dir, 'merged/report.json'), 'utf8').includes(representation)).toBe(false);
  }
}, 60_000);

it('rejects different pre-shard selections and invalid result identities', () => {
  const fixture = project();
  const testFile = path.join(fixture.dir, 'tests/shop.e2e.ts');
  writeFileSync(testFile, `import { test } from 'e2e';
for (const title of ['alpha', 'beta', 'gamma', 'delta']) test(title, async () => {});
`);
  expect(shard(fixture, 1).status).toBe(0);
  expect(cli(fixture, ['run', '--shard', '2/2', '--output', 'shard-2', '--repeat-each', '2', '--grep', 'alpha|beta|delta']).status).toBe(0);
  const args = ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged'];
  const incompatible = cli(fixture, args);
  expect(incompatible.status).toBe(2);
  expect(incompatible.stderr).toContain('incompatible shard selection');
  expect(shard(fixture, 2).status).toBe(0);
  const malformed = report(fixture, 'shard-2');
  malformed.results[0]!.id = 'not-a-report-result-id';
  writeFileSync(path.join(fixture.dir, 'shard-2/report.json'), JSON.stringify({ schemaVersion: 'report-1', run: malformed }));
  const invalid = cli(fixture, args);
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain('report-1 document');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);

it('rejects an input missing a field required by the published report schema', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const run = report(fixture, 'shard-2');
  const { os: _os, ...environment } = run.environment;
  writeFileSync(path.join(fixture.dir, 'shard-2/report.json'), JSON.stringify({
    schemaVersion: 'report-1',
    run: { ...run, environment },
  }));
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status).toBe(2);
  expect(merged.stderr).toMatch(/shard-2.*\/run\/environment.*required/);
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);

it('can merge a report when the engine never produced a screenshot file', () => {
  const fixture = project();
  writeFileSync(path.join(fixture.dir, 'e2e.config.ts'), `
import { defineEngine, ENGINE_SPI_VERSION } from 'e2e/engine';
const engine = defineEngine({
  name: 'fake', version: '1.0.0', spiVersion: ENGINE_SPI_VERSION,
  async observe() { throw new Error('no observation required'); },
  artifacts: { async screenshot() { return 'missing.png'; } },
});
export default { targets: [{ name: 'fake', platform: 'fake', engine }], workers: 1, cache: 'off' };
`);
  writeFileSync(path.join(fixture.dir, 'tests/shop.e2e.ts'), `
import { test } from 'e2e';
test('records a screenshot', async ({ app }) => { await app.screenshot(); });
`);
  const ran = cli(fixture, ['run', '--shard', '1/1', '--output', 'shard-1']);
  expect(ran.status, ran.stderr).toBe(0);
  const artifact = report(fixture, 'shard-1').results[0]?.attempts[0]?.artifacts[0];
  expect(artifact).toMatchObject({ kind: 'screenshot', redaction: 'incomplete' });
  expect(artifact?.path).toBeUndefined();
  const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(0);
  expect(report(fixture, 'merged').summary.passed).toBe(1);
}, 60_000);

it('rejects fresh shards with different repeat counts', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(cli(fixture, ['run', '--shard', '2/2', '--output', 'shard-2']).status).toBe(0);
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status).toBe(2);
  expect(merged.stderr).toContain('different repeat counts');
}, 60_000);

it('refuses a rerun that still owes tests when its folded history is missing', () => {
  const fixture = project();
  const run = ['--shard', '1/1', '--output', 'shard-1'];
  expect(cli(fixture, ['run', ...run], { FAIL_CART: '1', FAIL_CHECKOUT: '1' }).status).toBe(1);
  expect(cli(fixture, ['run', ...run, '--last-failed', '--grep', 'cart']).status).toBe(0);
  expect(report(fixture, 'shard-1').carried?.results.some((row) => row.titlePath.at(-1) === 'checkout')).toBe(true);
  rmSync(path.join(fixture.dir, 'shard-1/report-with-reruns.json'));
  const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(merged.status).toBe(2);
  expect(merged.stderr).toContain('requires its matching report-with-reruns.json');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);

it('rejects incompatible target environments and setup agents', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const run = report(fixture, 'shard-2');
  const reportPath = path.join(fixture.dir, 'shard-2/report.json');
  const write = () => writeFileSync(reportPath, JSON.stringify({ schemaVersion: 'report-1', run }));
  const args = ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged'];
  const target = run.targets[0]!;
  const original = target.environment;
  target.environment = original === 'staging' ? 'production' : 'staging';
  write();
  const environment = cli(fixture, args);
  expect(environment.status).toBe(2);
  expect(environment.stderr).toContain('different targets');
  target.environment = original;
  const setup = run.results.find((row) => row.selected && row.kind === 'setup')!;
  setup.id = '0'.repeat(64);
  setup.agent = 'different-agent';
  write();
  const agents = cli(fixture, args);
  expect(agents.status).toBe(2);
  expect(agents.stderr).toContain('incompatible setup agents');
}, 60_000);

it('ignores a stale rerun report before validating its schema', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const first = report(fixture, 'shard-1');
  const second = report(fixture, 'shard-2');
  const { os: _os, ...environment } = second.environment;
  const history = path.join(fixture.dir, 'shard-1/report-with-reruns.json');
  const merge = ['merge-reports', 'shard-1', 'shard-2', '--output'];
  writeFileSync(history, JSON.stringify({ schemaVersion: 'report-1', run: { ...second, environment } }));
  const stale = cli(fixture, [...merge, 'merged']);
  expect(stale.status, stale.stderr).toBe(0);
  expect(report(fixture, 'merged').summary.failed).toBe(0);

  writeFileSync(history, JSON.stringify({ schemaVersion: 'report-1', run: { ...second, id: first.id, environment } }));
  const matching = cli(fixture, [...merge, 'invalid']);
  expect(matching.status).toBe(2);
  expect(matching.stderr).toMatch(/report-with-reruns.*environment: required/);
  expect(existsSync(path.join(fixture.dir, 'invalid'))).toBe(false);
}, 60_000);

it('rejects duplicate merged result ids across different shard owners', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const one = report(fixture, 'shard-1');
  const two = report(fixture, 'shard-2');
  const cart = one.results.find((row) => row.selected && row.kind === 'test')!;
  const marker = two.results.find((row) => row.id === cart.id)!;
  const checkout = two.results.find((row) => row.selected && row.kind === 'test')!;
  expect(marker.skip?.otherShard).toBe(true);
  marker.id = '0'.repeat(64);
  checkout.id = cart.id;
  const document = { schemaVersion: 'report-1', run: two };
  assertValidReport(document);
  writeFileSync(path.join(fixture.dir, 'shard-2/report.json'), JSON.stringify(document));
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status).toBe(2);
  expect(merged.stderr).toContain('merged report repeats result id');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);

it('reports an interrupted result left behind by a passing shard rerun', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const run = report(fixture, 'shard-1');
  const cart = run.results.find((row) => row.selected && row.kind === 'test')!;
  cart.status = 'interrupted';
  cart.attempts[0]!.status = 'interrupted';
  const folded = { schemaVersion: 'report-1', run };
  assertValidReport(folded);
  writeFileSync(path.join(fixture.dir, 'shard-1/report-with-reruns.json'), JSON.stringify(folded));
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(130);
  const result = report(fixture, 'merged');
  expect(result.status).toBe('interrupted');
  expect(result.results.find((row) => row.id === cart.id)?.status).toBe('interrupted');
}, 60_000);

it('keeps serial group results and shard failure limits in the final verdict', () => {
  const fixture = project();
  writeFileSync(path.join(fixture.dir, 'tests/shop.e2e.ts'), `import { test } from 'e2e';
test.describe('order', { serial: true }, () => {
  test('alpha', async () => { if (process.env.FAIL_CHECKOUT) throw new Error('alpha failed'); });
  test('beta', async () => {});
});
test('gamma', async () => {});
test('delta', async () => {});
`);
  for (const index of [1, 2]) {
    const result = cli(fixture, ['run', '--shard', `${index}/2`, '--max-failures', '1', '--output', `shard-${index}`], index === 1 ? { FAIL_CHECKOUT: '1' } : {});
    expect(result.status).toBe(index === 1 ? 1 : 0);
  }
  const before = report(fixture, 'shard-1');
  const after = report(fixture, 'shard-2');
  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(1);
  const run = report(fixture, 'merged');
  expect(run.results.map((row) => [row.titlePath.at(-1), row.status, row.skip?.cause])).toEqual([
    ['alpha', 'failed', undefined],
    ['beta', 'skipped', 'serial-predecessor-failed'],
    ['gamma', 'skipped', 'failure-limit'],
    ['delta', 'passed', undefined],
  ]);
  expect(run.serialGroups).toHaveLength(1);
  expect(run.serialGroups[0]?.attempts[0]?.shard).toBe(1);
  expect(run.usage.artifactBytes).toBe(before.usage.artifactBytes + after.usage.artifactBytes);

  const duplicate = { schemaVersion: 'report-1', run: { ...before, serialGroups: [...before.serialGroups, ...before.serialGroups] } };
  assertValidReport(duplicate);
  writeFileSync(path.join(fixture.dir, 'shard-1/report.json'), JSON.stringify(duplicate));
  const invalid = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'invalid']);
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain('shard 1 repeats serial group id');
  expect(existsSync(path.join(fixture.dir, 'invalid'))).toBe(false);
}, 60_000);

it('identifies missing and duplicate shards before writing any report', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  const missing = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(missing.status, missing.stderr).toBe(2);
  expect(missing.stderr).toContain('missing shard 2');
  const duplicate = cli(fixture, ['merge-reports', 'shard-1', 'shard-1', '--output', 'merged']);
  expect(duplicate.status).toBe(2);
  expect(duplicate.stderr).toContain('duplicate shard 1');
  expect(existsSync(path.join(fixture.dir, 'merged'))).toBe(false);
}, 60_000);

it('keeps exit 1 when a fresh shard reaches its duration limit during a test', () => {
  const fixture = project();
  writeFileSync(path.join(fixture.dir, 'tests/shop.e2e.ts'), `import { test } from 'e2e';
test('slow', async () => { await new Promise((resolve) => setTimeout(resolve, 8000)); });
`);
  const ran = cli(fixture, ['run', '--shard', '1/1', '--output', 'shard-1', '--max-duration', '1500']);
  expect(ran.status, ran.stderr).toBe(1);
  expect(report(fixture, 'shard-1').summary.interrupted).toBe(1);
  const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(report(fixture, 'merged')).toMatchObject({ status: 'failed', exitCode: 1 });
}, 60_000);

it('keeps exit 1 when a fresh shard stops at its failure limit while another test runs', () => {
  const fixture = project();
  writeFileSync(path.join(fixture.dir, 'tests/shop.e2e.ts'), `import { test } from 'e2e';
test('slow', async () => { await new Promise((resolve) => setTimeout(resolve, 8000)); });
`);
  writeFileSync(path.join(fixture.dir, 'tests/zz-broken.e2e.ts'), `import { test } from 'e2e';
test('broken', async () => { await new Promise((resolve) => setTimeout(resolve, 500)); throw new Error('broken'); });
`);
  const ran = cli(fixture, ['run', '--shard', '1/1', '--output', 'shard-1', '--workers', '2', '--max-failures', '1']);
  expect(ran.status, ran.stderr).toBe(1);
  expect(report(fixture, 'shard-1').summary.interrupted).toBe(1);
  const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(1);
  expect(report(fixture, 'merged')).toMatchObject({ status: 'failed', exitCode: 1 });
}, 60_000);

it('merges shards when one report could not record the commit and retains the known commit', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const first = report(fixture, 'shard-1');
  const second = report(fixture, 'shard-2');
  const { vcs: _firstVcs, ...firstWithoutVcs } = first;
  const { vcs: _secondVcs, ...secondWithoutVcs } = second;
  const commit = 'a'.repeat(40);
  const write = (index: number, run: Report1Document['run']) => {
    const document = { schemaVersion: 'report-1', run };
    assertValidReport(document);
    writeFileSync(path.join(fixture.dir, `shard-${index}/report.json`), JSON.stringify(document));
  };
  const command = ['merge-reports', 'shard-1', 'shard-2', '--output'];
  write(1, firstWithoutVcs);
  write(2, { ...second, vcs: { commit } });
  const firstMissing = cli(fixture, [...command, 'first-missing']);
  expect(firstMissing.status, firstMissing.stderr).toBe(0);
  expect(firstMissing.stderr).toContain('shard 1 did not record a commit');
  expect(report(fixture, 'first-missing').vcs?.commit).toBe(commit);

  write(1, { ...first, vcs: { commit } });
  write(2, secondWithoutVcs);
  const secondMissing = cli(fixture, [...command, 'second-missing']);
  expect(secondMissing.status, secondMissing.stderr).toBe(0);
  expect(secondMissing.stderr).toContain('shard 2 did not record a commit');
  expect(report(fixture, 'second-missing').vcs?.commit).toBe(commit);

  write(2, { ...second, vcs: { commit: 'b'.repeat(40) } });
  const incompatible = cli(fixture, [...command, 'incompatible']);
  expect(incompatible.status).toBe(2);
  expect(incompatible.stderr).toContain('shard 2 has a different commit');
}, 60_000);

it('rejects an explicitly selected live-only command-line reporter', () => {
  const fixture = project();
  expect(cli(fixture, ['run', '--shard', '1/1', '--output', 'shard-1']).status).toBe(0);
  for (const id of ['list', 'dot', 'line']) {
    const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged', '--reporter', id]);
    expect(merged.status, id).toBe(2);
    expect(merged.stderr, id).toContain('expected json, junit, markdown, ctrf');
    expect(existsSync(path.join(fixture.dir, 'merged')), id).toBe(false);
  }
}, 60_000);

it('accepts on the command line every built-in that reports a finished run', () => {
  const fixture = project();
  expect(cli(fixture, ['run', '--shard', '1/1', '--output', 'shard-1']).status).toBe(0);
  const merged = cli(fixture, ['merge-reports', 'shard-1', '--output', 'merged', '--reporter', 'junit,markdown,ctrf']);
  expect(merged.status, merged.stderr).toBe(0);
  for (const file of ['junit.xml', 'summary.md', 'ctrf.json']) {
    expect(existsSync(path.join(fixture.dir, 'merged', file)), file).toBe(true);
  }
}, 60_000);

it('merges shards whose app requested a different free port each time, and rejects a different fixed port', () => {
  const fixture = project();
  const configPath = path.join(fixture.dir, 'e2e.config.ts');
  const originalConfig = readFileSync(configPath, 'utf8');
  const config = originalConfig.replace('app: FAKE_APP', `app: {
    url: 'http://127.0.0.1:0',
    command: { executable: process.execPath, args: ['server.cjs'], env: { PORT: '{port}' } },
  }`);
  writeFileSync(configPath, config);
  writeFileSync(path.join(fixture.dir, 'server.cjs'), `require('node:http')
    .createServer((_request, response) => response.end('ready'))
    .listen(Number(process.env.PORT), '127.0.0.1');`);
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const second = report(fixture, 'shard-2');
  const firstOrigin = report(fixture, 'shard-1').targets[0]?.baseOrigin;
  expect(second.targets[0]?.baseOrigin).not.toBe(firstOrigin);
  const merge = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merge.status, merge.stderr).toBe(0);
  expect(report(fixture, 'merged').targets[0]?.baseOrigin).toBe(firstOrigin);

  writeFileSync(configPath, originalConfig);
  expect(shard(fixture, 2).status).toBe(0);
  const mismatch = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'invalid']);
  expect(mismatch.status).toBe(2);
  expect(mismatch.stderr).toContain('different targets');
}, 60_000);

it('warns when a shard used different engine metadata', () => {
  const fixture = project();
  expect(shard(fixture, 1).status).toBe(0);
  expect(shard(fixture, 2).status).toBe(0);
  const run = report(fixture, 'shard-2');
  const target = run.targets[0]!;
  target.stateCapability = !target.stateCapability;
  const document = { schemaVersion: 'report-1', run };
  assertValidReport(document);
  writeFileSync(path.join(fixture.dir, 'shard-2/report.json'), JSON.stringify(document));

  const merged = cli(fixture, ['merge-reports', 'shard-1', 'shard-2', '--output', 'merged']);
  expect(merged.status, merged.stderr).toBe(0);
  expect(merged.stderr).toContain('shard 2 has different engine metadata for target "fake"');
}, 60_000);
