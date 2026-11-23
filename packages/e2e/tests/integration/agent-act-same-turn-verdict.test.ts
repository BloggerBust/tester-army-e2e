/**
 * A `complete_step` the model sends in the same turn as the step's last
 * action: it waits for that action instead of skipping it, ends the step
 * without a turn spent reading the result, and is refused when the action
 * failed or had no visible effect. A call after it in the turn never runs.
 * Real Playwright observations and actions on the fixture app.
 */

import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolLoopExecutor } from '@e2e-dev/core/lib/agent/tool-loop';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { installFakeLoopModel, loopCalls, nodeIdFor } from '../helpers/fake-loop-model.ts';
import { resultByTitle, runProject } from '../helpers/run-project.ts';

/** The counter suite, checking the count the step leaves behind. */
function counterSuite(count: number): string {
  return `import { test, expect } from 'e2e';

test('increments the counter', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('tap Increment once');
  await expect(screen.getByRole('status')).toHaveText('${String(count)}');
});
`;
}

const COUNTER_SUITE = counterSuite(1);

const DEAD_END_SUITE = `import { test } from 'e2e';

test('taps the dead end button', async ({ app, agent }) => {
  await app.open('/delayed');
  await agent.act('tap the dead end button');
});
`;

const CONTINUE_SUITE = `import { test, expect } from 'e2e';

test('taps through to the second view', async ({ app, agent, screen }) => {
  await app.open('/delayed');
  await agent.act('tap the dead end button, then tap Continue');
  await expect(screen.getByRole('heading', { name: 'Second view' })).toBeVisible();
});
`;

const PASSED = { status: 'passed', summary: 'tapped it' } as const;

const TOOL_SUITE = `import { test } from 'e2e';

test('runs the check', async ({ app, agent }) => {
  await app.open();
  await agent.act('run the check');
});
`;

/** A tool-loop executor whose only tool is `check`, as the project wrote it. */
function checkExecutor(check: ToolSet[string]) {
  return createToolLoopExecutor({ name: 'check-only', buildPrompt: (ctx) => ctx.step.instruction, tools: () => ({ check }) });
}

/** An async iterable of `values`, then `error` thrown when one is given. */
async function* outputs(values: readonly string[], error?: Error): AsyncGenerator<string> {
  for (const value of values) yield value;
  if (error !== undefined) throw error;
}

describe('a verdict sent in the same turn as the last action', () => {
  let app: FixtureApp;

  beforeAll(async () => {
    app = await startFixtureApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('runs the action first and ends the step in one model call', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn > 1) throw new Error(`unexpected turn ${String(call.turn)}: ${call.lastToolResult}`);
      return [
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } },
        { toolName: 'complete_step', input: PASSED },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/counter.e2e.ts': COUNTER_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'increments the counter');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.status).toBe('passed');
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(1);
      expect(loopCalls).toHaveLength(1);
      // The rule that tells the model it may do this goes out with every step.
      expect(loopCalls[0]!.system).toContain('send that action and then complete_step with status "passed" in one reply');
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('is refused when the action had no visible effect, and the model concludes again', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) {
        return [
          { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Dead end"/) } },
          { toolName: 'complete_step', input: PASSED },
        ];
      }
      return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'the dead end button did nothing', errorCode: 'ACTION_FAILED' } }];
    });
    const { outcome, project } = await runProject(
      { 'tests/dead-end.e2e.ts': DEAD_END_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'taps the dead end button');
      expect(result.status).toBe('failed');
      expect(result.attempts.at(-1)!.error?.message).toContain('the dead end button did nothing');
      const [tap, verdict] = loopCalls[1]!.toolResults;
      expect(tap).toContain('No listed node changed within the wait after this action');
      expect(verdict).toContain('Rejected: tap had no visible effect in this turn');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.modelCalls).toBe(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('is taken when only an earlier action of the turn changed nothing', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn > 1) throw new Error(`unexpected turn ${String(call.turn)}: ${call.lastToolResult}`);
      return [
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Dead end"/) } },
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Continue"/) } },
        { toolName: 'complete_step', input: PASSED },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/continue.e2e.ts': CONTINUE_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'taps through to the second view');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.actionSteps).toBe(2);
      expect(step.metrics!.modelCalls).toBe(1);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('is refused when the action failed', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) {
        return [
          { toolName: 'tap', input: { target: 'n99999' } },
          { toolName: 'complete_step', input: PASSED },
        ];
      }
      return [
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } },
        { toolName: 'complete_step', input: PASSED },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/counter.e2e.ts': COUNTER_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'increments the counter');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      const [tap, verdict] = loopCalls[1]!.toolResults;
      expect(tap).toMatch(/^tap #?n99999 failed: /);
      expect(verdict).toContain('Rejected: tap failed in this turn');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.modelCalls).toBe(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('is refused when the SDK turned the action away before it ran', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn === 1) {
        return [
          { toolName: 'tap', input: { target: 42 } },
          { toolName: 'complete_step', input: PASSED },
        ];
      }
      return [
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } },
        { toolName: 'complete_step', input: PASSED },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/counter.e2e.ts': COUNTER_SUITE },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'increments the counter');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      expect(loopCalls[1]!.toolResults.at(-1)).toContain('Rejected: tap did not run in this turn');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.actionSteps).toBe(1);
      expect(step.metrics!.modelCalls).toBe(2);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('runs nothing the model sent after it', async () => {
    const model = installFakeLoopModel((call) => {
      if (call.turn > 1) throw new Error(`unexpected turn ${String(call.turn)}: ${call.lastToolResult}`);
      return [
        { toolName: 'complete_step', input: PASSED },
        { toolName: 'tap', input: { target: nodeIdFor(call.prompt, /button "Increment"/) } },
      ];
    });
    const { outcome, project } = await runProject(
      { 'tests/counter.e2e.ts': counterSuite(0) },
      { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model } } } },
    );
    try {
      const result = resultByTitle(outcome, 'increments the counter');
      expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
      expect(result.status).toBe('passed');
      const step = result.attempts.at(-1)!.steps.find((candidate) => candidate.api === 'agent.act')!;
      expect(step.metrics!.actionSteps).toBe(0);
      expect(step.metrics!.modelCalls).toBe(1);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  describe('after a project tool that is not a promise', () => {
    const verdictAfterCheck = () =>
      installFakeLoopModel((call) => {
        if (call.turn === 1) return [{ toolName: 'check', input: {} }, { toolName: 'complete_step', input: PASSED }];
        return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'the check failed', errorCode: 'ACTION_FAILED' } }];
      });

    it.each([
      ['a failure it returns at once', () => 'Tool "check" failed: no rows'],
      ['an iterable that throws', () => outputs(['checking'], new Error('no rows'))],
      ['an iterable whose last output is a failure', () => outputs(['checking', 'Tool "check" failed: no rows'])],
    ])('refuses the verdict after %s', async (_, execute) => {
      const model = verdictAfterCheck();
      const executor = checkExecutor(tool({ description: 'Run the check', inputSchema: z.object({}), execute }));
      const { outcome, project } = await runProject(
        { 'tests/check.e2e.ts': TOOL_SUITE },
        { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model, executor } } } },
      );
      try {
        const result = resultByTitle(outcome, 'runs the check');
        expect(result.status).toBe('failed');
        expect(result.attempts.at(-1)!.error?.message).toContain('the check failed');
        expect(loopCalls[1]!.toolResults.at(-1)).toContain('Rejected: check failed in this turn');
      } finally {
        project.cleanup();
      }
    }, 120_000);

    it('takes the verdict after an iterable that ends well, and the model reads its last output', async () => {
      const model = installFakeLoopModel((call) => {
        if (call.turn > 1) throw new Error(`unexpected turn ${String(call.turn)}: ${call.lastToolResult}`);
        return [{ toolName: 'check', input: {} }, { toolName: 'complete_step', input: PASSED }];
      });
      const executor = checkExecutor(tool({ description: 'Run the check', inputSchema: z.object({}), execute: () => outputs(['checking', 'all rows present']) }));
      const { outcome, project } = await runProject(
        { 'tests/check.e2e.ts': TOOL_SUITE },
        { appUrl: app.url, config: { tests: 'tests/**/*.e2e.ts', agents: { default: { model, executor } } } },
      );
      try {
        const result = resultByTitle(outcome, 'runs the check');
        expect(result.attempts.at(-1)!.error?.message ?? '').toBe('');
        expect(result.status).toBe('passed');
        expect(loopCalls).toHaveLength(1);
      } finally {
        project.cleanup();
      }
    }, 120_000);
  });
});
