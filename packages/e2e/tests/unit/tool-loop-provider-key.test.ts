/**
 * A model that repeats a provider key it was shown, in an error it read or
 * on a screen, is not handed the key again as its own words, and the turn
 * the step reports holds no part of it, however the report cuts the turn.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@e2e-dev/core/lib/agent/tool';
import { defineEngine } from '@e2e-dev/core/lib/engine/index';
import { createEngineSession } from '@e2e-dev/core/lib/engine/session';
import { Deadline } from '@e2e-dev/core/lib/internal/time';
import { AttemptBudget } from '@e2e-dev/core/lib/run/budget';
import { createFixtures } from '@e2e-dev/core/lib/run/fixtures';
import { processSecrets, registerProviderKey } from '@e2e-dev/core/lib/run/secrecy';
import { StepRecorder } from '@e2e-dev/core/lib/run/steps';
import { WorkerModels } from '@e2e-dev/core/lib/run/worker-models';
import { resolveConfig } from '../../src/config/resolve-run.ts';
import type { E2EConfig } from '../../src/run-types.ts';
import { runAgentStepsOnFakeTime } from '../helpers/agent-fake-time.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { snapshot } from '../helpers/snapshot.ts';

runAgentStepsOnFakeTime();

/** A real fixture graph with an in-memory engine and no runner process or model provider. */
function runtime(overrides: Partial<E2EConfig> = {}) {
  const engine = defineEngine({ name: 'fake', version: '1', spiVersion: 1, observe: async () => snapshot([]) });
  const config = resolveConfig({ targets: [{ name: 'fake', platform: 'custom', engine }], cache: 'off', ...overrides }, { projectRoot: process.cwd(), env: {} });
  const signal = new AbortController().signal;
  const steps = new StepRecorder('attempt');
  const { fixtures } = createFixtures({
    config,
    target: config.targets[0]!,
    session: createEngineSession({ engine, targetName: 'fake' }),
    steps,
    budget: new AttemptBudget(signal, new Deadline(10_000)),
    runId: 'run',
    attemptId: 'attempt',
    attempt: { testId: 'test', attemptId: 'attempt', titlePath: [], index: 0, signal, memory: new Map() },
    artifacts: { dir: '/tmp', register: () => 'artifact', link: () => 'artifact' },
    priorSteps: () => steps.completed(),
    agentContext: undefined,
    saveSession: undefined,
    models: new WorkerModels(() => {}),
  });
  return { fixtures, steps };
}

const peek = defineTool({ inputSchema: z.object({}), execute: async () => 'looked' }, { mutates: false });
const conclude = { toolName: 'complete_step', input: { status: 'passed', summary: 'done' } };

describe('a provider key the model repeats', () => {
  it('is redacted in the model\'s own words before they are sent back to it', async () => {
    const key = 'sk-loop-history-7a2e9c4f1b6d8035';
    registerProviderKey('loop.history-key', key);
    const model = installFakeLoopModel(({ turn }) =>
      turn === 1 ? { toolCalls: [{ toolName: 'peek', input: {} }], text: `the error quoted ${key}`, reasoning: `thinking of ${key}` } : [conclude],
    );
    const { fixtures } = runtime({ agents: { default: { tools: { peek }, model } } });

    await fixtures.agent.act('look around');

    // Its reasoning goes back as it wrote it: a provider signs reasoning, and refuses it changed.
    expect(loopCalls[1]?.assistantText).toEqual([`thinking of ${key}`, 'the error quoted <secret:loop.history-key>']);
    // What the tool answered is still there, as it was.
    expect(loopCalls[1]?.lastToolResult).toBe('looked');
  });

  it('is redacted in the system text a config wrote it into, before the model reads it', async () => {
    const key = 'sk-loop-system-5e1a8c3f9d2b7046';
    registerProviderKey('loop.system-key', key);
    const model = installFakeLoopModel(() => [conclude]);
    const { fixtures } = runtime({ agents: { default: { model, system: `Sign in with ${key} when the form asks.` } } });

    await fixtures.agent.act('look around');

    expect(loopCalls[0]?.system).toContain('Sign in with <secret:loop.system-key> when the form asks.');
    expect(loopCalls[0]?.system).not.toContain(key.slice(-12));
  });

  it('leaves a value an earlier test learned in the system text as it is', async () => {
    processSecrets.register('earlier.pin', 'order-5d2f8e1a7c');
    const model = installFakeLoopModel(() => [conclude]);
    const { fixtures } = runtime({ agents: { default: { model, system: 'Select order-5d2f8e1a7c in the list.' } } });

    await fixtures.agent.act('look around');

    expect(loopCalls[0]?.system).toContain('Select order-5d2f8e1a7c in the list.');
  });

  it('reaches the model as its marker in an instruction', async () => {
    const key = 'sk-loop-instruction-8a3c6e1f4b9d2057';
    registerProviderKey('loop.instruction-key', key);
    const model = installFakeLoopModel(() => [conclude]);
    const { fixtures } = runtime({ agents: { default: { model } } });

    await fixtures.agent.act(`type ${key} into the key field`);

    expect(loopCalls[0]?.prompt).toContain('type <secret:loop.instruction-key> into the key field');
    expect(loopCalls[0]?.prompt).not.toContain(key.slice(-12));
  });

  it('is redacted from the model the step records, when the key was given as its id', async () => {
    const key = 'sk-loop-model-id-4b9e2d7a1c6f3085';
    registerProviderKey('loop.model-key', key);
    const model = installFakeLoopModel(() => [conclude]);
    Object.defineProperty(model, 'modelId', { value: key });
    const { fixtures, steps } = runtime({ agents: { default: { model } } });

    await fixtures.agent.act('look around');

    const recorded = steps.all()[0]?.model;
    expect(recorded?.model).toBe('<secret:loop.model-key>');
    expect(JSON.stringify(steps.all())).not.toContain(key.slice(-12));
  });

  it.each([
    ['the 600 characters a reported turn is cut to', 579],
    ['the 1000 characters a turn\'s prose is cut to', 990],
  ])('is redacted in the turn the step reports before the cut at %s', async (_label, padding) => {
    const key = `sk-loop-report-${String(padding)}-3c8f0a5d7e2b9146`;
    registerProviderKey('loop.report-key', key);
    // The key starts 10 characters before the cut: cutting first would keep its head.
    const prose = `${'x'.repeat(padding)}${key} and more`;
    const model = installFakeLoopModel(({ turn }) => (turn === 1 ? { text: prose } : [conclude]));
    const { fixtures, steps } = runtime({ agents: { default: { model } } });

    await fixtures.agent.act('look around');

    const reported = JSON.stringify(steps.all());
    expect(reported).toContain('assistant: xxxxxxxx');
    expect(reported).not.toContain(key.slice(0, 10));
    if (padding === 579) expect(reported).toContain(`${'x'.repeat(579)}<secret:lo…[truncated]`);
  });
});
