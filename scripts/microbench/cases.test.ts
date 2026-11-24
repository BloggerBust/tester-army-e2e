import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CHILD = path.join(import.meta.dirname, 'child.mjs');

/**
 * Every case loads, runs, and passes its own check against this checkout's
 * build, so a renamed module or a changed result fails here before it fails
 * a benchmark run. Needs the packages built, as `pnpm test` does first.
 */
describe('microbench cases', () => {
  const cases = JSON.parse(execFileSync(process.execPath, [CHILD, '--list'], { encoding: 'utf8' })) as { name: string }[];

  it('has unique names', () => {
    assert.equal(new Set(cases.map((entry) => entry.name)).size, cases.length);
  });

  for (const { name } of cases) {
    it(`${name} runs one iteration in both modes`, () => {
      for (const flags of [[], ['--jitless']]) {
        const stdout = execFileSync(process.execPath, [...flags, '--expose-gc', CHILD, REPO_ROOT, name, '1'], { encoding: 'utf8' });
        assert.equal(typeof (JSON.parse(stdout) as { ns: unknown }).ns, 'number');
      }
    });
  }
});
