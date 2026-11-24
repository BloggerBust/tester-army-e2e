/**
 * `locator.screenshot()` in a real run: the step links the artifact it
 * wrote, the report it lands in is valid, and the file is the match alone.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '@e2e-dev/core/lib/internal/image';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { resultByTitle, runProject, type FixtureProject, type RunOutcome } from '../helpers/run-project.ts';

const SUITE = `import { test } from '@e2e-dev/web';

test('captures the heading', async ({ app, screen }) => {
  await app.open();
  const heading = screen.getByRole('heading').first();
  const box = await heading.boundingBox();
  const file = await heading.screenshot('heading');
  if (!file.endsWith('heading.png')) throw new Error('unexpected file ' + file);
  if (box === null) throw new Error('the heading has no box');
});
`;

describe('locator.screenshot in a run', () => {
  let app: FixtureApp;
  let outcome: RunOutcome;
  let project: FixtureProject;

  beforeAll(async () => {
    app = await startFixtureApp();
    ({ outcome, project } = await runProject({ 'tests/shot.e2e.ts': SUITE }, { appUrl: app.url }));
  });

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('links one screenshot artifact from its step, on a path the report schema takes', () => {
    const result = resultByTitle(outcome, 'captures the heading');
    expect(result.status, JSON.stringify(result.attempts.at(-1)?.error)).toBe('passed');
    assertValidReport(outcome.report);
    const attempt = result.attempts[0]!;
    const step = attempt.steps.find((candidate) => candidate.api === 'locator.screenshot')!;
    expect(step.label).toContain('heading');
    expect(step.artifacts).toHaveLength(1);
    const artifact = attempt.artifacts.find((candidate) => candidate.id === step.artifacts[0])!;
    expect(artifact).toMatchObject({ kind: 'screenshot', mediaType: 'image/png' });
    expect(artifact.path).toMatch(/\/screenshots\/001-heading\.png$/);
    expect(artifact.path).not.toContain('\\');
  });

  it('writes the match alone: smaller than the viewport on both sides', () => {
    const attempt = resultByTitle(outcome, 'captures the heading').attempts[0]!;
    const artifact = attempt.artifacts.find((candidate) => candidate.kind === 'screenshot')!;
    const image = decodePng(readFileSync(path.join(project.dir, '.e2e', 'results', artifact.path!)));
    expect(image.width).toBeLessThan(1280);
    expect(image.height).toBeLessThan(720);
    expect(image.height).toBeGreaterThan(0);
  });
});
