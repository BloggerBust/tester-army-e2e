import { describe, expect, it } from 'vitest';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

describe('test.todo', () => {
  it('reports an unfinished test as skipped without running it', async () => {
    const { outcome, project } = await runProject(
      {
        'tests/todo.e2e.ts': `import { test } from 'e2e';

test('ready', async () => {});
test.todo('future');
`,
      },
      {},
    );
    try {
      const todo = resultByTitle(outcome, 'future');
      expect(outcome.exitCode).toBe(0);
      expect(todo).toMatchObject({
        status: 'skipped',
        selected: true,
        attempts: [],
        skip: { cause: 'todo', reason: 'todo' },
      });
      expect(outcome.report.run.summary).toMatchObject({ selected: 2, executed: 1, passed: 1, skipped: 1 });
      expect(outcome.report.run.summary).not.toHaveProperty('todo');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('rejects a TODO-only selection as NO_TESTS', async () => {
    const { outcome, project } = await runProject(
      { 'tests/todo.e2e.ts': `import { test } from 'e2e';\ntest.todo('future');\n` },
      {},
    );
    try {
      expect(outcome.exitCode).toBe(2);
      expect(outcome.report.run.errors).toEqual([expect.objectContaining({ code: 'NO_TESTS', phase: 'collection' })]);
      expect(outcome.report.run.errors[0]?.message).toContain('1 marked todo');
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });

  it('allows a TODO-only selection with passWithNoTests', async () => {
    const { outcome, project } = await runProject(
      { 'tests/todo.e2e.ts': `import { test } from 'e2e';\ntest.todo('future');\n` },
      { runOptions: { passWithNoTests: true } },
    );
    try {
      expect(outcome.exitCode).toBe(0);
      expect(resultByTitle(outcome, 'future')).toMatchObject({
        status: 'skipped',
        selected: true,
        attempts: [],
        skip: { cause: 'todo', reason: 'todo' },
      });
      assertValidReport(outcome.report);
    } finally {
      project.cleanup();
    }
  });
});
