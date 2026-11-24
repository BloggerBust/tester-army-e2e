/** A run with no model key fails each step that needs a live model call, naming the unset variable, and goes on: a test with no agent step still passes, and nothing stops the run. */

import { createOpenAI } from '@ai-sdk/openai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';

const JUDGE = `test('judges', async ({ app, agent }) => {
  await app.open();
  await agent.assert('the page is open');
});`;

const ACT = `test('acts', async ({ app, agent }) => {
  await app.open();
  await agent.act('do the thing');
});`;

const MODEL_FREE = `test('opens the app', async ({ app }) => {
  await app.open();
});`;

/** One suite file of the given tests. */
function suite(...tests: readonly string[]): string {
  return `import { test } from '@e2e-dev/web';\n\n${tests.join('\n\n')}\n`;
}

const NO_KEY = /^the model has no credential: OPENAI_API_KEY is not set, so no request was sent\. Set OPENAI_API_KEY, or pass the key where the model is constructed$/;

describe('a run with no model key', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { first: 'a judgment', tests: [JUDGE, ACT, MODEL_FREE] },
    { first: 'an act step', tests: [ACT, JUDGE, MODEL_FREE] },
  ])('fails each test that calls the model when $first calls it first, and passes the one that does not', async ({ tests }) => {
    vi.stubEnv('OPENAI_API_KEY', undefined);
    let requests = 0;
    const keyless = createOpenAI({
      fetch: async () => {
        requests += 1;
        return new Response('{}', { status: 500 });
      },
    })('gpt-6-luna');
    const project: FixtureProject = createProject({ 'tests/keyless.e2e.ts': suite(...tests) });
    try {
      const outcome = await runExisting(project, {
        appUrl: app.url,
        config: { tests: 'tests/**/*.e2e.ts', cache: 'off', retries: 1, agents: { default: { model: keyless } } },
      });
      expect(outcome.exitCode).toBe(3);
      expect(outcome.report.run.errors).toEqual([]);
      const results = outcome.report.run.results.map((result) => ({
        status: result.status,
        attempts: result.attempts.length,
        code: result.attempts[0]?.error?.code,
        message: result.attempts[0]?.error?.message,
      }));
      expect(results).toEqual([
        { status: 'failed', attempts: 1, code: 'MODEL_PROVIDER_FAILED', message: expect.stringMatching(NO_KEY) },
        { status: 'failed', attempts: 1, code: 'MODEL_PROVIDER_FAILED', message: expect.stringMatching(NO_KEY) },
        { status: 'passed', attempts: 1, code: undefined, message: undefined },
      ]);
      expect(JSON.stringify(outcome.report)).not.toContain('the provider rejected the credential');
      expect(requests).toBe(0);
    } finally {
      project.cleanup();
    }
  }, 60_000);
});
