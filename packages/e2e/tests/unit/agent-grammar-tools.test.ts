/**
 * The vocabulary the model calls is closed. On a tool that declares fields,
 * a field the schema does not declare fails validation instead of being
 * stripped, so a call the model decorated with `force` or `selector` is
 * refused rather than run without it. A tool with no fields drops those
 * keys and runs on `{}`.
 */

import type { ModelMessage, ToolSet } from 'ai';
import { z } from 'zod';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { aiSdk, loadAiSdk } from '@e2e-dev/core/lib/agent/ai-sdk';
import { AgentError } from '@e2e-dev/core/lib/agent/error';
import { isFailedResult, waitingToolNames } from '@e2e-dev/core/lib/agent/loop-guards';
import { GRAMMAR_TOOL_NAMES } from '@e2e-dev/core/lib/agent/action-names';
import { createGrammarTools, createVerdictTool, grammarTools } from '@e2e-dev/core/lib/agent/primitives';
import { createBuiltInAgent, projectTools } from '@e2e-dev/core/lib/agent/default-agent';
import { createToolLoopExecutor } from '@e2e-dev/core/lib/agent/tool-loop';
import { defineTool } from '@e2e-dev/core/lib/agent/tool';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';

it('does not repeat a static assertion opening to request pixels it cannot use', async () => {
  const { context } = fakeExecutorContext({ verbs: [], secrets: [] });
  const observe = vi.fn(async () => ({
    revision: '1', text: '#n1 text "Static content"', truncated: false,
    viewport: { width: 800, height: 600 },
  }));
  const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'read static content' } }]);
  await expect(createBuiltInAgent().runStep({
    ...context, step: { ...context.step, kind: 'assert', vision: false }, model, observe,
  })).resolves.toMatchObject({ status: 'passed' });
  expect(observe).toHaveBeenCalledExactlyOnceWith({ pixels: false });
});

/** An input each tool accepts; a tool added to the grammar without one fails the vocabulary check. */
const ACCEPTED: Readonly<Record<string, Record<string, unknown>>> = {
  observe: {},
  tap: { target: 'n1' },
  double_tap: { target: 'n1' },
  long_press: { target: 'n1' },
  right_click: { target: 'n1' },
  hover: { target: 'n1' },
  type: { target: 'n1', value: 'ada' },
  type_secret: { target: 'n1', name: 'admin' },
  press: { target: 'n1', key: 'Shift+ArrowLeft', times: 8 },
  select: { target: 'n1', value: 'Pro' },
  check: { target: 'n1', checked: false },
  scroll: { direction: 'down', times: 2 },
  scroll_to: { target: 'n1' },
  drag: { target: 'n1', to: 'n2' },
  upload: { target: 'n1', files: ['fixtures/a.txt'] },
  navigate: { url: '/about' },
  back: {},
  resize_viewport: { width: 390, height: 844 },
  switch_tab: { tab: 2 },
  close_tab: { tab: 2 },
  screenshot: {},
  tap_at: { x: 10, y: 20 },
  hover_at: { x: 10, y: 20 },
  drag_at: { x: 10, y: 20, to_x: 30, to_y: 40 },
  type_at: { x: 10, y: 20, value: 'ada', replace: true },
  press_at: { x: 10, y: 20, key: 'Enter' },
  select_at: { x: 10, y: 20, value: 'Pro' },
  dismiss_keyboard: {},
};

/** Tools whose schema declares no fields. A padded call is read as `{}`; every other tool stays closed. */
const NO_INPUT = new Set(['observe', 'back', 'dismiss_keyboard', 'screenshot']);

function schemaOf(tools: ToolSet, name: string): z.ZodType {
  const tool = tools[name];
  if (tool?.inputSchema === undefined) throw new Error(`no schema on ${name}`);
  return tool.inputSchema as z.ZodType;
}

/** The accepted input passes; the same input with two undeclared fields fails on exactly those keys. */
function expectClosed(schema: z.ZodType, accepted: Record<string, unknown>, name: string): void {
  expect(schema.safeParse(accepted).success, `${name} accepts ${JSON.stringify(accepted)}`).toBe(true);
  const decorated = schema.safeParse({ ...accepted, force: true, selector: '#x' });
  expect(decorated.success, `${name} refuses undeclared fields`).toBe(false);
  if (decorated.success) return;
  expect(decorated.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  expect(decorated.error.issues[0]!.message).toBe('Unrecognized keys: "force", "selector"');
}

describe('the grammar tools have closed schemas', () => {
  it('offers the whole vocabulary over the full grammar; a tool with fields refuses one it does not declare, and a tool with none drops it', () => {
    const tools = createGrammarTools(fakeExecutorContext().context);
    expect(Object.keys(tools).toSorted()).toEqual([...GRAMMAR_TOOL_NAMES].toSorted());
    for (const name of Object.keys(tools)) {
      const schema = schemaOf(tools, name);
      const accepted = ACCEPTED[name]!;
      if (!NO_INPUT.has(name)) {
        expectClosed(schema, accepted, name);
        continue;
      }
      expect(schema.safeParse(accepted).success, `${name} accepts ${JSON.stringify(accepted)}`).toBe(true);
      const padded = schema.safeParse({ force: true, selector: '#x' });
      expect(padded.success, `${name} drops undeclared fields`).toBe(true);
      if (padded.success) expect(padded.data).toEqual({});
      for (const value of ['nope', null, []]) {
        const rejected = schema.safeParse(value);
        expect(rejected.success, `${name} rejects ${JSON.stringify(value)}`).toBe(false);
        if (!rejected.success) expect(rejected.error.issues.map((issue) => issue.code)).toEqual(['invalid_type']);
      }
    }
    const described = schemaOf(tools, 'screenshot').safeParse({ description: 'check the home screen' });
    expect(described.success).toBe(true);
    if (described.success) expect(described.data).toEqual({});
  });

  it('keeps screenshot strict once saveScreenshot adds a path field', () => {
    const schema = schemaOf(grammarTools(fakeExecutorContext().context, { saveScreenshot: async (file) => file }), 'screenshot');
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ path: 'screenshots/home.png' }).success).toBe(true);
    const padded = schema.safeParse({ path: 'screenshots/home.png', description: 'check' });
    expect(padded.success).toBe(false);
    if (padded.success) return;
    expect(padded.error.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  });

  it('scroll_to takes a listed node, a text to reach, or a text with the list to page, never nothing; a device gets the text form alone', () => {
    const full = schemaOf(createGrammarTools(fakeExecutorContext().context), 'scroll_to');
    expect(full.safeParse({ text: 'Row 4322', direction: 'down', target: 'n6' }).success).toBe(true);
    expect(full.safeParse({ text: 'Row 4322' }).success).toBe(true);
    expect(full.safeParse({ text: 'x'.repeat(201) }).success).toBe(false);
    expect(full.safeParse({ text: 'Row 4322', list: 'n6' }).success).toBe(false);
    expectClosed(full, { text: 'Row 4322' }, 'scroll_to');

    const device = createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'scroll', 'scrollUntil'] }).context);
    const byText = schemaOf(device, 'scroll_to');
    expect(byText.safeParse({ text: 'Row 0512' }).success).toBe(true);
    expect(byText.safeParse({ text: 'Row 0512', target: 'n3' }).success).toBe(true);
    expect(byText.safeParse({ target: 'n1' }).success).toBe(false);
    expectClosed(byText, { text: 'Row 0512', direction: 'down' }, 'scroll_to');

    const byNode = schemaOf(createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'scrollTo'] }).context), 'scroll_to');
    expect(byNode.safeParse({ text: 'Row 0512' }).success).toBe(false);
    expectClosed(byNode, { target: 'n1' }, 'scroll_to');
  });

  it('closes the keyboard-only shapes too: type and press without a target, scroll without one', () => {
    const tools = createGrammarTools(fakeExecutorContext({ verbs: ['typeText', 'pressKey', 'scroll'] }).context);
    expect(Object.keys(tools).toSorted()).toEqual(['observe', 'press', 'press_at', 'screenshot', 'scroll', 'type', 'type_at']);
    expectClosed(schemaOf(tools, 'type'), { value: 'ada', replace: true }, 'type');
    expectClosed(schemaOf(tools, 'press'), { key: 'Enter' }, 'press');
    expectClosed(schemaOf(tools, 'scroll'), { direction: 'down' }, 'scroll');
    // Without the id-addressed verb a target is not a field of type at all.
    expect(schemaOf(tools, 'type').safeParse({ target: 'n1', value: 'ada' }).success).toBe(false);
  });

  it('offers resize_viewport only with the resize verb, in whole pixels within the bounds', () => {
    expect(Object.keys(createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'back'] }).context))).not.toContain('resize_viewport');
    const resize = schemaOf(createGrammarTools(fakeExecutorContext({ verbs: ['resize'] }).context), 'resize_viewport');
    expect(resize.safeParse({ width: 1440, height: 900 }).success).toBe(true);
    expect(resize.safeParse({ width: 390.5, height: 844 }).success).toBe(false);
    expect(resize.safeParse({ width: 100, height: 844 }).success).toBe(false);
    expect(resize.safeParse({ width: 390, height: 5000 }).success).toBe(false);
    expect(resize.safeParse({ width: 390 }).success).toBe(false);
  });

  it('offers switch_tab only with the switchTab verb, by a whole tab number from 1', () => {
    expect(Object.keys(createGrammarTools(fakeExecutorContext({ verbs: ['tap', 'back'] }).context))).not.toContain('switch_tab');
    const switchTab = schemaOf(createGrammarTools(fakeExecutorContext({ verbs: ['switchTab'] }).context), 'switch_tab');
    expectClosed(switchTab, { tab: 2 }, 'switch_tab');
    expect(switchTab.safeParse({ tab: 0 }).success).toBe(false);
    expect(switchTab.safeParse({ tab: 1.5 }).success).toBe(false);
  });

  it('offers close_tab only with the closeTab verb, by a whole tab number from 1', () => {
    expect(Object.keys(createGrammarTools(fakeExecutorContext({ verbs: ['switchTab'] }).context))).not.toContain('close_tab');
    const closeTab = schemaOf(createGrammarTools(fakeExecutorContext({ verbs: ['closeTab'] }).context), 'close_tab');
    expectClosed(closeTab, { tab: 2 }, 'close_tab');
    expect(closeTab.safeParse({ tab: 0 }).success).toBe(false);
    expect(closeTab.safeParse({ tab: 1.5 }).success).toBe(false);
  });

  it('closes complete_step', () => {
    expectClosed(schemaOf({ complete_step: createVerdictTool().tool }, 'complete_step'), { status: 'passed', summary: 'done' }, 'complete_step');
  });

  it('accepts a passed verdict beside an error code: the body records the pass without the code and says what it dropped', async () => {
    // One model attaches ACTION_FAILED to about half of its passes; a schema refusal had it resend the identical call until the turn budget ran out.
    const passed = createVerdictTool();
    const schema = schemaOf({ complete_step: passed.tool }, 'complete_step');
    const contradictory = { status: 'passed', summary: 'done', errorCode: 'ACTION_FAILED' };
    expect(schema.safeParse(contradictory).success).toBe(true);
    const options = { toolCallId: 'verdict', messages: [], context: undefined };
    expect(await passed.tool.execute!(contradictory, options)).toBe('Step concluded as passed; the errorCode ACTION_FAILED you sent does not apply to a passed verdict and was ignored.');
    expect(passed.verdict()).toEqual({ status: 'passed', summary: 'done' });
    const failed = createVerdictTool();
    expect(await failed.tool.execute!({ status: 'failed', summary: 'done', errorCode: 'ACTION_FAILED' }, options)).toBe('Step concluded.');
    expect(failed.verdict()).toEqual({ status: 'failed', summary: 'done', errorCode: 'ACTION_FAILED' });
    expect(schema.safeParse({ status: 'blocked', summary: 'done', errorCode: 'ENVIRONMENT_UNAVAILABLE' }).success).toBe(true);
  });

  it('keeps the first verdict: a later complete_step in the same turn cannot turn a failure into a pass', async () => {
    const conclusion = createVerdictTool();
    const options = { toolCallId: 'verdict', messages: [], context: undefined };
    expect(await conclusion.tool.execute!({ status: 'failed', summary: 'total is wrong', errorCode: 'ASSERTION_FAILED' }, options)).toBe('Step concluded.');
    expect(await conclusion.tool.execute!({ status: 'passed', summary: 'looks fine' }, options)).toBe('The step already concluded.');
    expect(conclusion.verdict()).toEqual({ status: 'failed', summary: 'total is wrong', errorCode: 'ASSERTION_FAILED' });
  });

  it('refuses a blocked verdict without a blocking error code and leaves the step open for a real one', async () => {
    const conclusion = createVerdictTool();
    const options = { toolCallId: 'verdict', messages: [], context: undefined };
    expect(await conclusion.tool.execute!({ status: 'blocked', summary: 'could not tell' }, options)).toMatch(/^Rejected: a blocked verdict requires errorCode/);
    expect(await conclusion.tool.execute!({ status: 'blocked', summary: 'the total is wrong', errorCode: 'ASSERTION_FAILED' }, options)).toMatch(/^Rejected: /);
    expect(conclusion.concluded()).toBe(false);
    expect(await conclusion.tool.execute!({ status: 'blocked', summary: 'no login', errorCode: 'AUTH_CREDENTIAL_UNAVAILABLE' }, options)).toBe('Step concluded.');
    expect(conclusion.verdict()).toEqual({ status: 'blocked', summary: 'no login', errorCode: 'AUTH_CREDENTIAL_UNAVAILABLE' });
  });
});

describe('the schema a provider receives', () => {
  beforeAll(() => loadAiSdk());

  /** The JSON Schema the SDK sends for a tool: the conversion generateText runs on `inputSchema`. */
  const sent = (schema: z.ZodType) => aiSdk().asSchema(schema).jsonSchema as { additionalProperties?: unknown };
  /** What zod alone emits in the mode the SDK converts with, before the SDK's own pass over the result. */
  const emitted = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as { additionalProperties?: unknown };

  it('carries additionalProperties: false for every grammar tool and complete_step, from the schema itself', () => {
    const tools = { ...createGrammarTools(fakeExecutorContext().context), complete_step: createVerdictTool().tool };
    for (const [name, tool] of Object.entries(tools)) {
      const schema = tool.inputSchema as z.ZodType;
      expect(sent(schema).additionalProperties, `${name} as sent`).toBe(false);
      // The closed schema emits it on its own, so the wire shape does not rest on the SDK's pass.
      expect(emitted(schema).additionalProperties, `${name} from zod`).toBe(false);
    }
  });

  it('sends complete_step as the plain object: the errorCode rule is its description, never a keyword or a refinement', () => {
    const schema = createVerdictTool().tool.inputSchema as z.ZodType;
    expect(Object.keys(sent(schema)).toSorted()).toEqual(['$schema', 'additionalProperties', 'properties', 'required', 'type']);
    expect(Object.keys(emitted(schema)).toSorted()).toEqual(['$schema', 'additionalProperties', 'properties', 'required', 'type']);
  });
});


it('offers only viewport exploration tools to assertion steps', () => {
  const { context } = fakeExecutorContext();
  const tools = createGrammarTools({ ...context, step: { ...context.step, kind: 'assert' } });
  expect(Object.keys(tools).toSorted()).toEqual(['observe', 'screenshot', 'scroll', 'scroll_to']);
});


it('offers read-only project tools alongside assertion exploration', () => {
  const { context } = fakeExecutorContext();
  const tool = { inputSchema: z.object({}), execute: async () => 'read' };
  const tools = {
    read_status: defineTool(tool, { mutates: false }),
    write_status: defineTool(tool, { mutates: true }),
  };
  expect(Object.keys(projectTools({ ...context, step: { ...context.step, kind: 'assert' } }, tools))).toEqual(['read_status']);
  expect(Object.keys(projectTools(context, tools))).toEqual(['read_status', 'write_status']);
});

it('drops an inconclusive code from an act verdict and keeps it on an assertion', async () => {
  const input = { status: 'failed', summary: 'no evidence', errorCode: 'ASSERTION_INCONCLUSIVE' } as const;
  const options = { toolCallId: 'verdict', messages: [], context: undefined };
  const act = createVerdictTool('act');
  expect((act.tool.inputSchema as z.ZodType).safeParse(input).success).toBe(true);
  expect(await act.tool.execute!(input, options)).toBe('Step concluded as failed; the errorCode ASSERTION_INCONCLUSIVE you sent applies only to assertions and was ignored.');
  expect(act.verdict()).toEqual({ status: 'failed', summary: 'no evidence' });
  const assertion = createVerdictTool('assert');
  expect(await assertion.tool.execute!(input, options)).toBe('Step concluded.');
  expect(assertion.verdict()).toEqual(input);
});

describe('type_secret leaves the act tool set the same across steps', () => {
  it('describes it the same with the secrets listed by the caller, and fails a call on a step that declares none', async () => {
    const bare = fakeExecutorContext({ secrets: [] });
    const declared = fakeExecutorContext();
    const without = grammarTools(bare.context, { secretsListedByCaller: true })['type_secret'];
    const listed = grammarTools(declared.context, { secretsListedByCaller: true })['type_secret'];
    expect(without?.description).toBe(listed?.description);
    expect(listed?.description).not.toContain('admin');
    // The public grammar keeps naming the secrets, and offers none to a step without them.
    expect(createGrammarTools(bare.context)).not.toHaveProperty('type_secret');
    expect(createGrammarTools(declared.context)['type_secret']?.description).toContain('"admin" (password)');
  });

  it('sends a call on a step that declares no secrets to the dispatcher, whose refusal reads as a failed action', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const typeSecret = vi.fn(async () => {
      throw new AgentError('POLICY_DENIED', 'secret "admin" was not declared in this step\'s params; only declared secrets can be filled');
    });
    const observe = async () => ({ revision: '1', text: '#n1 textbox "Password"', truncated: false, viewport: { width: 800, height: 600 } });
    const tool = grammarTools({ ...context, observe, actions: { ...context.actions, typeSecret } }, { secretsListedByCaller: true })['type_secret'];
    const result = await tool!.execute!({ target: 'n1', name: 'admin' }, { toolCallId: 'fill', messages: [], context: undefined });
    const text = typeof result === 'string' ? result : result.text;
    expect(typeSecret).toHaveBeenCalledExactlyOnceWith({ id: 'n1' }, 'admin');
    expect(text).toMatch(/^type_secret "admin" into #n1 failed: POLICY_DENIED: secret "admin" was not declared/u);
    expect(isFailedResult('type_secret', text)).toBe(true);
  });

  it('offers the built-in act loop the same tools with and without a secret, and lists the secret in the opening message', async () => {
    const observe = async () => ({
      revision: '1', text: '#n1 textbox "Password"', truncated: false,
      viewport: { width: 800, height: 600 },
    });
    const model = installFakeLoopModel(() => [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }]);
    for (const secrets of [[], [{ name: 'admin', purpose: 'password' }]] as const) {
      const { context } = fakeExecutorContext({ secrets });
      await expect(createBuiltInAgent().runStep({ ...context, model, observe })).resolves.toMatchObject({ status: 'passed' });
    }
    expect(loopCalls).toHaveLength(2);
    expect(loopCalls[0]!.toolNames).toContain('type_secret');
    expect(loopCalls[1]!.toolNames).toEqual(loopCalls[0]!.toolNames);
    expect(loopCalls[0]!.prompt).not.toContain('Secrets to fill');
    expect(loopCalls[1]!.prompt).toContain('Secrets to fill with type_secret, by name: "admin" (password).');
  });
});

describe('observe matches the act rules on checking a commit', () => {
  it('allows observe to check any press that commits something, not only a save or submit', () => {
    const { context } = fakeExecutorContext();
    const description = grammarTools(context, { secretsListedByCaller: true })['observe']?.description;
    expect(description).toContain('or to check whether a press that commits something (a save, a submit, a delete) went through');
    expect(description).toContain("never to re-read another action's result");
  });
});

describe('the loop guard waits longer on the built-in observe only', () => {
  beforeAll(() => loadAiSdk());

  /** A model that observes until the loop forces a verdict, and how many times it observed. */
  const observeUntilForced = () => {
    let observed = 0;
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1 && call.toolNames[0] === 'complete_step') {
        return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'still saving' } }];
      }
      observed += 1;
      return [{ toolName: 'observe', input: {} }];
    });
    return { model, observed: () => observed };
  };

  it('marks observe and the plain screenshot as waiting tools, and not the screenshot that saves a file', () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    expect([...waitingToolNames(grammarTools(context, {}))].toSorted()).toEqual(['observe', 'screenshot']);
    expect([...waitingToolNames(createGrammarTools(context))].toSorted()).toEqual(['observe', 'screenshot']);
    expect([...waitingToolNames(grammarTools(context, { saveScreenshot: async (file) => file }))]).toEqual(['observe']);
  });

  it('lets the built-in act loop observe ten times while a save stays in progress', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const observe = async () => ({ revision: '1', text: '#n1 button "Saving" [disabled]', truncated: false, viewport: { width: 800, height: 600 } });
    const { model, observed } = observeUntilForced();
    await expect(createBuiltInAgent().runStep({ ...context, model, observe })).resolves.toMatchObject({ status: 'failed' });
    expect(observed()).toBe(10);
    const warned = loopCalls.find((call) => call.lastPrompt.includes('the screen was looked at several times in a row with no change'));
    expect(warned?.lastPrompt).toContain('Observe again only while the screen still shows the work in progress');
    expect(warned?.lastPrompt).toContain('once it is done, do what the step still asks for, then call complete_step');
    expect(warned?.lastPrompt).not.toContain('going in circles');
  });

  it('gives each notice of a wait once, however the wait alternates between ticking and standing still', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    let looks = 0;
    const observe = async () => {
      looks += 1;
      // Observes 1-12 tick, 13-18 stand still on the last tick, 19 on tick again until the guard ends the wait at twenty.
      const call = looks - 1;
      const second = call <= 12 || call >= 19 ? call : 12;
      return { revision: String(looks), text: `#n1 text "Saving ${String(second)}s"`, truncated: false, viewport: { width: 800, height: 600 } };
    };
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1) return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'forced' } }];
      return [{ toolName: 'observe', input: {} }];
    });
    await createBuiltInAgent().runStep({ ...context, model, observe });
    const added = (notice: string) =>
      loopCalls.filter((call, index) => index > 0 && call.userMessages > loopCalls[index - 1]!.userMessages && call.lastPrompt.includes(notice)).length;
    expect(added('looked at many times in a row while it kept changing')).toBe(1);
    expect(added('looked at several times in a row with no change')).toBe(1);
  });

  it('keeps a recovered listing as progress after compaction elides it from the history the model reads', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const big = Array.from({ length: 900 }, (_, index) => `#n${String(index + 10)} text "row ${String(index)} ${'x'.repeat(40)}"`).join('\n');
    let looks = 0;
    const observe = async () => {
      looks += 1;
      // Opening look, then: no tree, no tree, the listing back (large) on the third observe, no tree after it.
      if (looks === 4) return { revision: String(looks), text: big, truncated: false, viewport: { width: 800, height: 600 } };
      if (looks === 1) return { revision: '1', text: '#n1 button "Saving" [disabled]', truncated: false, viewport: { width: 800, height: 600 } };
      return { revision: String(looks), text: '[semantic capture unavailable]', truncated: true, treeUnavailable: true as const, viewport: { width: 800, height: 600 } };
    };
    let observed = 0;
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1) return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'forced' } }];
      observed += 1;
      return [{ toolName: 'observe', input: {} }];
    });
    await createBuiltInAgent().runStep({ ...context, model, observe });
    // The third observe saw the listing come back, so ten unchanged looks are counted from the fourth: thirteen in all.
    expect(observed).toBe(13);
  });

  it('warns each wait in a step, not only the first', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    let looks = 0;
    const observe = async () => {
      looks += 1;
      // The opening look and six observes show the first save in progress; then it is done, and the second save never ends.
      const text = looks <= 7 ? '#n1 button "Saving" [disabled]' : looks === 8 ? '#n1 button "Saved"\n#n2 button "Send"' : '#n2 button "Sending" [disabled]';
      return { revision: String(looks), text, truncated: false, viewport: { width: 800, height: 600 } };
    };
    let sent = false;
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1) return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'forced' } }];
      if (!sent && call.lastToolResult.includes('"Send"')) {
        sent = true;
        return [{ toolName: 'tap', input: { target: 'n2' } }];
      }
      return [{ toolName: 'observe', input: {} }];
    });
    await createBuiltInAgent().runStep({ ...context, model, observe });
    const notice = 'the screen was looked at several times in a row with no change';
    // A notice joins the history as a new user message, so count the turns that added one.
    const warned = loopCalls.filter((call, index) => index > 0 && call.userMessages > loopCalls[index - 1]!.userMessages && call.lastPrompt.includes(notice));
    // One warning per wait: the second wait, after the tap, is warned again.
    expect(sent).toBe(true);
    expect(warned).toHaveLength(2);
  });

  it('lets the act loop go on to the step\'s next action when the tenth observe shows the save finished', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    let looks = 0;
    const observe = async () => {
      looks += 1;
      // The opening look and nine observes show the save in progress; the tenth observe shows it done.
      const done = looks > 10;
      return { revision: String(looks), text: done ? '#n1 button "Saved"\n#n2 link "Product list"' : '#n1 button "Saving" [disabled]', truncated: false, viewport: { width: 800, height: 600 } };
    };
    const tools: string[] = [];
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1) return [{ toolName: 'complete_step', input: { status: 'failed', summary: 'forced' } }];
      // The loop let the tap through: that is all this test asks, whatever the fake engine does with it.
      if (tools.at(-1) === 'tap') return [{ toolName: 'complete_step', input: { status: 'passed', summary: 'saved, then opened the list' } }];
      if (call.lastToolResult.includes('"Product list"')) {
        tools.push('tap');
        return [{ toolName: 'tap', input: { target: 'n2' } }];
      }
      tools.push('observe');
      return [{ toolName: 'observe', input: {} }];
    });
    await expect(createBuiltInAgent().runStep({ ...context, model, observe })).resolves.toMatchObject({ status: 'passed' });
    expect(tools).toEqual([...Array.from({ length: 10 }, () => 'observe'), 'tap']);
  });

  it('keeps the ordinary limit for a caller\'s own tool named observe, which may write', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const writes: string[] = [];
    const executor = createToolLoopExecutor({
      name: 'custom',
      system: 'Record observations.',
      buildPrompt: () => 'go',
      tools: () => ({
        observe: { description: 'Records an observation.', inputSchema: aiSdk().zodSchema(z.object({})), execute: async () => { writes.push('row'); return 'recorded'; } },
      }) as ToolSet,
    });
    const { model, observed } = observeUntilForced();
    await expect(executor.runStep({ ...context, model })).resolves.toMatchObject({ status: 'failed' });
    expect(observed()).toBe(5);
    expect(writes).toHaveLength(5);
  });

  it('counts only the calls an executor keeps in the history it sends, not the ones its prepareMessages summarized away', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    let rows = 5;
    // The executor carries the five rows read in earlier steps into its prompt, then summarizes them away before the model reads it.
    const carried = Array.from({ length: 5 }, (_, index): ModelMessage[] => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `old${String(index)}`, toolName: 'read_row', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `old${String(index)}`, toolName: 'read_row', output: { type: 'text', value: `row ${String(index + 1)}` } }] },
    ]).flat();
    const executor = createToolLoopExecutor({
      name: 'custom',
      system: 'Read the next row.',
      buildPrompt: () => [{ role: 'user', content: 'Rows so far:' }, ...carried, { role: 'user', content: 'Read the next row.' }],
      tools: () => ({
        read_row: { description: 'Reads the next row.', inputSchema: aiSdk().zodSchema(z.object({})), execute: async () => `row ${String((rows += 1))}` },
      }) as ToolSet,
      prepareMessages: (messages) => messages.filter((message) => message.role === 'user' || !carried.includes(message)),
    });
    const model = installFakeLoopModel((call) => {
      if (call.toolNames.length === 1 || rows >= 6) return [{ toolName: 'complete_step', input: { status: 'passed', summary: `read ${String(rows)} rows` } }];
      return [{ toolName: 'read_row', input: {} }];
    });
    await expect(executor.runStep({ ...context, model })).resolves.toMatchObject({ status: 'passed' });
    // The step read its row: the summarized calls did not force a verdict before its first turn.
    expect(rows).toBe(6);
  });

  it('keeps the ordinary limit when the caller replaces the built-in handler after the tools are built', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const writes: string[] = [];
    let offered: ToolSet | undefined;
    const executor = createToolLoopExecutor({
      name: 'custom',
      system: 'Record observations.',
      tools: (ctx) => {
        offered = { observe: createGrammarTools(ctx)['observe']! };
        return offered;
      },
      buildPrompt: () => {
        offered!['observe']!.execute = async () => { writes.push('row'); return 'recorded'; };
        return 'go';
      },
    });
    const { model, observed } = observeUntilForced();
    await expect(executor.runStep({ ...context, model })).resolves.toMatchObject({ status: 'failed' });
    expect(observed()).toBe(5);
    expect(writes).toHaveLength(5);
  });

  it('keeps the ordinary limit when a caller reuses the built-in observe with a handler of its own', async () => {
    const { context } = fakeExecutorContext({ secrets: [] });
    const writes: string[] = [];
    const executor = createToolLoopExecutor({
      name: 'custom',
      system: 'Record observations.',
      buildPrompt: () => 'go',
      tools: (ctx) => {
        const builtIn = createGrammarTools(ctx)['observe']!;
        builtIn.execute = async () => { writes.push('row'); return 'recorded'; };
        return { observe: builtIn };
      },
    });
    const { model, observed } = observeUntilForced();
    await expect(executor.runStep({ ...context, model })).resolves.toMatchObject({ status: 'failed' });
    expect(observed()).toBe(5);
    expect(writes).toHaveLength(5);
  });
});
