import { describe, expect, it } from 'vitest';
import { BASE_RULES } from '@e2e-dev/core/lib/agent/default-agent';
import { explorerAgent } from '../../src/explore/executor.ts';

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
