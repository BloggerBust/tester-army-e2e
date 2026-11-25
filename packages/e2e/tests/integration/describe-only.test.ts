/**
 * `describe.only` end to end: a focused group runs its tests, nested groups
 * included, beside a `test.only` elsewhere, and every other test stays out.
 * CI refuses it the way it refuses `test.only`.
 */

import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

const FILE = `import { describe, test } from 'e2e';

test('outside', async () => {});

describe.only('checkout', () => {
  test('pays', async () => {});
  describe('refunds', () => {
    test('refunds a card', async () => {});
  });
});

describe('profile', { only: true }, () => {
  test('renames', async () => {});
});

describe('settings', () => {
  test('sibling', async () => {});
  test.only('focused elsewhere', async () => {});
});
`;

describe('describe.only', () => {
  it(
    'runs the focused groups and a test.only beside them, and nothing else',
    async () => {
      const { outcome, project } = await runProject({ 'tests/focus.e2e.ts': FILE }, {});
      try {
        assertValidReport(outcome.report);
        expect(outcome.exitCode).toBe(0);
        const ran = outcome.report.run.results.filter((result) => result.status === 'passed').map((result) => result.titlePath.join(' > '));
        expect(ran).toEqual(['checkout > pays', 'checkout > refunds > refunds a card', 'profile > renames', 'settings > focused elsewhere']);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );

  it(
    'is refused in CI with ONLY_IN_CI',
    async () => {
      const { outcome, project } = await runProject(
        { 'tests/focus.e2e.ts': `import { describe, test } from 'e2e';\ndescribe.only('checkout', () => {\n  test('pays', async () => {});\n});\ntest('other', async () => {});\n` },
        { runOptions: { env: { ...process.env, CI: '1' } } },
      );
      try {
        expect(outcome.exitCode).toBe(2);
        expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'ONLY_IN_CI' })]);
        expect(outcome.report.run.results.filter((result) => result.status === 'passed')).toEqual([]);
      } finally {
        project.cleanup();
      }
    },
    120_000,
  );
});
