import { expect, it } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

it('aborts the engine calls of an afterAll hook that resumes in the next file, after the hooks that followed it', async () => {
  const hanging = `test.afterAll(async ({ app }) => {
  await new Promise<void>((resolve) => process.once('e2e-late-suite-hook-release', resolve));
  await app.open('/late-hook').catch(() => undefined);
  process.emit('e2e-late-suite-hook-finished');
});`;
  const passing = `test.afterAll(async ({ app }) => { await app.open('/hook'); });`;
  // Hooks on both sides of the hanging one, so a passing hook enters its budget after the timeout in either run order.
  const first = `import { test } from 'e2e';

${passing}
${hanging}
${passing}
test('has hooks', async ({ app }) => { await app.open('/body'); });
`;
  const second = `import { test } from 'e2e';

test('next file', async ({ app }) => {
  await app.open('/next');
  const finished = new Promise<void>((resolve) => process.once('e2e-late-suite-hook-finished', resolve));
  process.emit('e2e-late-suite-hook-release');
  await finished;
});
`;
  // A worker-isolation engine, as a device is: its fixtures reach suite hooks, and the next file runs on the same one.
  const fake = createFakeEngine({ isolation: 'worker' });
  const { outcome, project } = await runProject(
    { 'tests/a-hooks.e2e.ts': first, 'tests/b-next.e2e.ts': second },
    { config: engineConfig(fake.engine, { cleanupTimeout: 300, workers: 1 }) },
  );
  try {
    expect(resultByTitle(outcome, 'next file').status).toBe('passed');
    const late = fake.operations.filter((operation) => operation.method.endsWith('/late-hook)'));
    expect(late.map((operation) => operation.abortedAtCall)).toEqual([true]);
  } finally {
    project.cleanup();
  }
}, 120_000);
