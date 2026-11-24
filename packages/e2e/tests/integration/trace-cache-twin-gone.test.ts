/**
 * The trace cache when the recorded control is gone and a same-named twin is
 * left: the first run presses the first of two "Set up" buttons, the second
 * run sees only the other one. Pressing it would reach the same status, so
 * nothing after the step could catch it; the replay must hand the step back
 * to the executor instead, with nothing pressed.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureApp, type FixtureApp } from '../helpers/fixture-app.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import type { ScriptedNode } from '../helpers/scripted-scene.ts';
import { nodeIdFor } from '../helpers/fake-loop-model.ts';
import { createProject, resultByTitle, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import { readEntries } from '../helpers/trace-cache.ts';
import type { StepExecutor, StepExecutorContext } from '@e2e-dev/core/lib/agent/executor';
import type { TraceTargetDescriptor } from '@e2e-dev/core/lib/cache/trace';

const SUITE = `import { test, expect } from 'e2e';

test('sets up without test ids', async ({ app, agent, screen }) => {
  await app.open('/setup-twins');
  await agent.act('set up the first integration');
  await expect(screen.getByRole('status')).toHaveText('Setup opened');
});

test('sets up by test id', async ({ app, agent, screen }) => {
  await app.open('/setup-twins?ids=1');
  await agent.act('set up the first integration');
  await expect(screen.getByRole('status')).toHaveText('Setup opened');
});
`;

/** What the executor saw each time it was asked: the status line of its first observation. */
interface Calls {
  readonly statuses: string[];
}

/** Presses the first "Set up" button it sees, and notes the status the screen showed before it did. */
function firstSetUp(calls: Calls): StepExecutor {
  return {
    name: 'first-set-up',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      const observation = await context.observe();
      calls.statuses.push(/status "Setup"[^\n]*/.exec(observation.text)?.[0] ?? '');
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Set up"/) });
      return { status: 'passed' as const, summary: 'pressed Set up' };
    },
  };
}

/** The recorded target of the entry each test wrote, by test title. */
function recordedTargets(project: FixtureProject): Record<string, TraceTargetDescriptor | undefined> {
  const targets: Record<string, TraceTargetDescriptor | undefined> = {};
  for (const { entry } of readEntries(project)) {
    const title = decodeURIComponent(entry.payload.recordedFor?.testId.split('::').at(-1) ?? '');
    const [first] = entry.payload.actions;
    targets[title] = first?.name === 'tap' ? first.target : undefined;
  }
  return targets;
}

describe('trace cache: the recorded control is gone and its twin is left', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const runs: Calls[] = [];

  const options = () => {
    const calls: Calls = { statuses: [] };
    runs.push(calls);
    return {
      appUrl: app.url,
      config: {
        tests: 'tests/**/*.e2e.ts',
        reporters: ['json'] as const,
        workers: 1,
        agents: { default: { executor: firstSetUp(calls) } },
        cache: 'read-write' as const,
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({ 'tests/setup.e2e.ts': SUITE });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('hands the step back with nothing pressed, with or without test ids', async () => {
    const first = await runExisting(project, options());
    expect(first.exitCode).toBe(0);
    const targets = recordedTargets(project);
    expect(targets['sets up without test ids']).toEqual({ role: 'button', name: 'Set up', position: { index: 0, of: 2 } });
    expect(targets['sets up by test id']).toMatchObject({ role: 'button', name: 'Set up', testId: 'setup-primary' });

    app.setVariant('b');
    // Under --strict-cache the step fails as stale, with nothing pressed and no executor call.
    const strict = await runExisting(project, { ...options(), runOptions: { strictCache: true } });
    expect(strict.exitCode).toBe(2);
    for (const title of ['sets up without test ids', 'sets up by test id']) {
      const step = resultByTitle(strict, title).attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
      expect(step.error?.code, title).toBe('REPLAY_STALE');
      expect(step.cache, title).toMatchObject({ reason: 'target-ambiguous', replayedActions: 0 });
    }
    expect(runs.at(-1)!.statuses).toEqual([]);

    const second = await runExisting(project, options());
    expect(second.exitCode).toBe(0);
    for (const title of ['sets up without test ids', 'sets up by test id']) {
      const step = resultByTitle(second, title).attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
      expect(step.cache, title).toMatchObject({ mode: 'missed', reason: 'target-ambiguous', replayedActions: 0 });
    }
    // The executor ran for both steps and found nothing pressed before it acted.
    expect(runs.at(-1)!.statuses).toEqual(['status "Setup" text="Not started"', 'status "Setup" text="Not started"']);
  }, 240_000);
});

describe('trace cache: one step presses two twins from one look', () => {
  let app: FixtureApp;
  let project: FixtureProject;
  const runs: number[] = [];

  /** Presses both "Remove" buttons the first look lists, without looking again in between. */
  const both: (calls: number[]) => StepExecutor = (calls) => ({
    name: 'remove-both',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      calls[0] = (calls[0] ?? 0) + 1;
      const observation = await context.observe();
      const ids = [...observation.text.matchAll(/#(\S+) button "Remove"/g)].map((match) => match[1]!);
      for (const id of ids) await context.actions.tap({ id });
      return { status: 'passed' as const, summary: `removed ${String(ids.length)}` };
    },
  });

  const options = () => {
    const calls: number[] = [];
    runs.push(0);
    return {
      calls,
      run: {
        appUrl: app.url,
        config: {
          tests: 'tests/**/*.e2e.ts',
          reporters: ['json'] as const,
          workers: 1,
          agents: { default: { executor: both(calls) } },
          cache: 'read-write' as const,
        },
      },
    };
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'tests/remove.e2e.ts': `import { test, expect } from 'e2e';

test('removes both drafts', async ({ app, agent, screen }) => {
  await app.open('/remove-twins');
  await agent.act('remove both drafts');
  await expect(screen.getByRole('status')).toHaveText('2 removed');
});
`,
    });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('replays both presses with no executor call, as the step recorded them', async () => {
    const first = options();
    expect((await runExisting(project, first.run)).exitCode).toBe(0);
    expect(first.calls[0]).toBe(1);
    // The second press was addressed from the look the first one ran from, so its count is marked.
    const [entry] = readEntries(project);
    expect(entry!.entry.payload.actions.map((action) => (action.name === 'tap' ? action.target : undefined))).toEqual([
      { role: 'button', name: 'Remove', position: { index: 0, of: 2 } },
      { role: 'button', name: 'Remove', position: { index: 1, of: 2 }, countedOnEarlierLook: true },
    ]);
    const second = options();
    const replayed = await runExisting(project, second.run);
    expect(replayed.exitCode).toBe(0);
    const step = resultByTitle(replayed, 'removes both drafts').attempts.at(-1)!.steps.find((s) => s.api === 'agent.act')!;
    expect(step.cache).toMatchObject({ mode: 'self-finalized', replayedActions: 2, totalActions: 2 });
    expect(second.calls[0]).toBeUndefined();
  }, 240_000);
});

describe('trace cache: one step presses two twins with a look between', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  /** Presses the first "Set up" button, looks again, then presses the second. */
  const lookBetween: StepExecutor = {
    name: 'look-between',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      for (const index of [0, 1]) {
        const observation = await context.observe();
        const ids = [...observation.text.matchAll(/#(\S+) button "Set up"/g)].map((match) => match[1]!);
        await context.actions.tap({ id: ids[index]! });
      }
      return { status: 'passed' as const, summary: 'pressed both' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'tests/both.e2e.ts': `import { test, expect } from 'e2e';

test('sets up both', async ({ app, agent, screen }) => {
  await app.open('/setup-twins');
  await agent.act('set up both integrations');
  await expect(screen.getByRole('status')).toHaveText('Setup opened');
});
`,
    });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('trusts the count of a press addressed from a fresh look', async () => {
    const run = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] as const, workers: 1, agents: { default: { executor: lookBetween } }, cache: 'read-write' as const },
    });
    expect(run.exitCode).toBe(0);
    const [entry] = readEntries(project);
    expect(entry!.entry.payload.actions.map((action) => (action.name === 'tap' ? action.target : undefined))).toEqual([
      { role: 'button', name: 'Set up', position: { index: 0, of: 2 } },
      { role: 'button', name: 'Set up', position: { index: 1, of: 2 } },
    ]);
  }, 240_000);
});

describe('trace cache: one step presses a twin and a lone control from one look', () => {
  let app: FixtureApp;
  let project: FixtureProject;

  /** Presses the first "Set up" button, then "Done", both from one look. */
  const oneLook: StepExecutor = {
    name: 'one-look',
    version: 'test',
    async runStep(context: StepExecutorContext) {
      const observation = await context.observe();
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Set up"/) });
      await context.actions.tap({ id: nodeIdFor(observation.text, /button "Done"/) });
      return { status: 'passed' as const, summary: 'set up and done' };
    },
  };

  beforeAll(async () => {
    app = await startFixtureApp();
    project = createProject({
      'tests/done.e2e.ts': `import { test, expect } from 'e2e';

test('sets up and finishes', async ({ app, agent, screen }) => {
  await app.open('/setup-twins?done=1');
  await agent.act('set up the first integration and finish');
  await expect(screen.getByRole('status')).toHaveText('Setup opened');
});
`,
    });
  }, 60_000);

  afterAll(async () => {
    project?.cleanup();
    await app?.close();
  });

  it('marks no count for a control the description names alone', async () => {
    const run = await runExisting(project, {
      appUrl: app.url,
      config: { tests: 'tests/**/*.e2e.ts', reporters: ['json'] as const, workers: 1, agents: { default: { executor: oneLook } }, cache: 'read-write' as const },
    });
    expect(run.exitCode).toBe(0);
    const [entry] = readEntries(project);
    expect(entry!.entry.payload.actions.map((action) => (action.name === 'tap' ? action.target : undefined))).toEqual([
      { role: 'button', name: 'Set up', position: { index: 0, of: 2 } },
      { role: 'button', name: 'Done' },
    ]);
  }, 240_000);
});

describe('trace cache: a press right after scrolling to text', () => {
  it('trusts the count of a press addressed from the look the scroll ended on', async () => {
    const fake = createFakeEngine({
      actions: ['tap', 'swipe'],
      scene: () => {
        const status: ScriptedNode = { id: 'status', role: 'status', name: 'Setup', text: 'Not started' };
        const press = (action: { kind: string }) => { if (action.kind === 'tap') status.text = 'Setup opened'; };
        return [
          status,
          { id: 'first', role: 'button', name: 'Set up', appearsAfterSwipes: 1, rect: { x: 0, y: 20, width: 100, height: 40 }, on: press },
          { id: 'second', role: 'button', name: 'Set up', appearsAfterSwipes: 1, rect: { x: 0, y: 80, width: 100, height: 40 }, on: press },
        ];
      },
    });
    // No look between the scroll and the press: the scroll read its last page after its last swipe.
    const executor: StepExecutor = {
      name: 'scroll-then-press',
      version: 'test',
      async runStep(context: StepExecutorContext) {
        await context.observe();
        await context.actions.scrollUntil('Set up', 'down');
        await context.actions.tap({ id: 'first' });
        return { status: 'passed' as const, summary: 'pressed Set up' };
      },
    };
    const project = createProject({
      'tests/scroll.e2e.ts': `import { test, expect } from 'e2e';
test('scrolls and sets up', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('scroll to Set up and press it');
  await expect(screen.getByRole('status', { name: 'Setup' })).toHaveText('Setup opened');
});`,
    });
    try {
      const run = await runExisting(project, {
        appUrl: FAKE_APP_URL,
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [{ name: 'device', platform: 'ios' as const, engine: fake.engine, app: FAKE_APP }],
          agents: { default: { executor } },
          cache: 'read-write' as const,
        },
      });
      expect(run.exitCode, JSON.stringify(run.report.run.errors)).toBe(0);
      const [entry] = readEntries(project);
      const tap = entry!.entry.payload.actions.find((action) => action.name === 'tap');
      expect(tap?.name === 'tap' ? tap.target : undefined).toEqual({ role: 'button', name: 'Set up', within: 'Not started', position: { index: 0, of: 2 } });
    } finally {
      project.cleanup();
    }
  }, 240_000);

  it('keeps the earlier-look mark when the text is already in view and the scroll takes no page', async () => {
    const fake = createFakeEngine({
      actions: ['tap', 'swipe'],
      scene: () => {
        const status: ScriptedNode = { id: 'status', role: 'status', name: 'Setup', text: 'Not started' };
        const press = (action: { kind: string }) => { if (action.kind === 'tap') status.text = 'Setup opened'; };
        return [
          status,
          { id: 'first', role: 'button', name: 'Set up', rect: { x: 0, y: 20, width: 100, height: 40 }, on: press },
          { id: 'second', role: 'button', name: 'Set up', rect: { x: 0, y: 80, width: 100, height: 40 }, on: press },
        ];
      },
    });
    // Both presses are addressed from the one look taken before the scroll, which finds its text on that look.
    const executor: StepExecutor = {
      name: 'press-scroll-press',
      version: 'test',
      async runStep(context: StepExecutorContext) {
        await context.observe();
        await context.actions.tap({ id: 'first' });
        await context.actions.scrollUntil('Set up', 'down');
        await context.actions.tap({ id: 'second' });
        return { status: 'passed' as const, summary: 'pressed Set up twice' };
      },
    };
    const project = createProject({
      'tests/scroll.e2e.ts': `import { test, expect } from 'e2e';
test('sets up twice', async ({ app, agent, screen }) => {
  await app.open();
  await agent.act('press Set up, scroll to Set up, press the other one');
  await expect(screen.getByRole('status', { name: 'Setup' })).toHaveText('Setup opened');
});`,
    });
    try {
      const run = await runExisting(project, {
        appUrl: FAKE_APP_URL,
        config: {
          tests: 'tests/**/*.e2e.ts',
          targets: [{ name: 'device', platform: 'ios' as const, engine: fake.engine, app: FAKE_APP }],
          agents: { default: { executor } },
          cache: 'read-write' as const,
        },
      });
      expect(run.exitCode, JSON.stringify(run.report.run.errors)).toBe(0);
      const [entry] = readEntries(project);
      const last = entry!.entry.payload.actions.findLast((action) => action.name === 'tap');
      expect(last?.name === 'tap' ? last.target : undefined).toMatchObject({ position: { index: 1, of: 2 }, countedOnEarlierLook: true });
    } finally {
      project.cleanup();
    }
  }, 240_000);
});
