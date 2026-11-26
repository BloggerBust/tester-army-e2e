import { describe, expect, it } from 'vitest';
import type { ToolExecutionOptions } from 'ai';
import { BASE_RULES } from '@e2e-dev/core/lib/agent/default-agent';
import { type DefinedTool, withToolContext } from '@e2e-dev/core/lib/agent/tool';
import { explorerAgent, FINDING_TOOL_NAME, withFindingTool } from '../../src/explore/executor.ts';
import { ExploreState } from '../../src/explore/state.ts';

describe('the explorer agent', () => {
  it('puts its own charter over the built-in commit rule: submitting twice and revisiting after a save are deliberate', () => {
    const explorer = explorerAgent({ state: {} as never, agentName: 'default', entry: { system: 'Be careful.' }, resolved: {} as never, notice: () => {} });
    // The built-in rules come first in the system prompt; the explorer's guidance follows them and says it wins.
    expect(BASE_RULES).toContain('Never repeat a commit');
    expect(explorer.system).toContain('Be careful.');
    expect(explorer.system).toContain('These rules take precedence over the built-in rules above where they differ');
    expect(explorer.system).toContain('submitting twice quickly');
    expect(explorer.system).toContain('After a save, reload or revisit and check what was kept.');
  });
});

describe('the finding tool', () => {
  const report = { title: 'Total shows $0.00', kind: 'issue', severity: 4, expected: 'a total', actual: '$0.00', reproduction: ['open the cart'] };

  /** Starts a report that waits in `pending`, its observation or its evidence screenshot's save, until `release`. */
  function reporting(state: ExploreState, pending: 'observe' | 'attachScreenshot') {
    const { tool } = withFindingTool({ tools: {} } as never, state).tools[FINDING_TOOL_NAME] as DefinedTool;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const attached: string[] = [];
    const options = withToolContext({ toolCallId: 'call-1', messages: [] } as unknown as ToolExecutionOptions<unknown>, {
      observe: async () => {
        if (pending === 'observe') await released;
        return { revision: 3, pixels: {} } as never;
      },
      read: async () => {
        throw new Error('not read');
      },
      attachScreenshot: async (_pixels, label) => {
        attached.push(label);
        if (pending === 'attachScreenshot') await released;
        return 'attempt-1:artifact:0';
      },
    });
    const done = Promise.resolve(tool.execute!(report, options));
    return { done, release, attached };
  }

  for (const pending of ['observe', 'attachScreenshot'] as const) {
    it(`records a finding against the step it was reported in, when that step ended at its deadline during ${pending}`, async () => {
      const state = new ExploreState('goal', { maxSteps: 4, timeoutMs: 300_000 });
      state.beginStep('Cart', 'open the cart');
      const { done, release } = reporting(state, pending);
      await new Promise((resolve) => setImmediate(resolve));
      state.endStep('exhausted', 'step timed out', 'STEP_TIMEOUT');
      state.beginStep('Checkout', 'pay');
      release();
      await done;
      expect(state.findings.map((finding) => finding.step)).toEqual([1]);
    });
  }

  it('records nothing once the exploration is over', async () => {
    const state = new ExploreState('goal', { maxSteps: 4, timeoutMs: 300_000 });
    state.beginStep('Cart', 'open the cart');
    const { done, release } = reporting(state, 'attachScreenshot');
    await new Promise((resolve) => setImmediate(resolve));
    state.endStep('exhausted', 'step timed out', 'STEP_TIMEOUT');
    state.end('time');
    state.close();
    release();
    await expect(done).rejects.toThrow(/exploration is over/);
    expect(state.findings).toEqual([]);
  });

  it('keeps no screenshot for a finding the closed record refuses', async () => {
    const state = new ExploreState('goal', { maxSteps: 4, timeoutMs: 300_000 });
    state.beginStep('Cart', 'open the cart');
    const { done, release, attached } = reporting(state, 'observe');
    await new Promise((resolve) => setImmediate(resolve));
    state.endStep('exhausted', 'step timed out', 'STEP_TIMEOUT');
    state.end('time');
    state.close();
    release();
    await expect(done).rejects.toThrow(/exploration is over/);
    expect(attached).toEqual([]);
  });
});
