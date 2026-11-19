/**
 * Renders one agent step and its calls for the list reporter: the same
 * finished step prints in a CI log, in a file block, and in the live window,
 * each at its own indent, so nothing here knows where the line lands.
 */

import type { HeldStep, StepPrompt } from '../run/step-hold.ts';
import type { StepRecord } from '@e2e-dev/core/lib/run/steps';
import { modelLabel } from '@e2e-dev/core/lib/config/agent';
import { sanitizeText, truncateUtf8 } from '@e2e-dev/core/lib/internal/errors';
import { collapseText } from '@e2e-dev/core/lib/internal/text';
import {
  bounded,
  F_CHECK,
  F_CROSS,
  fitColumns,
  formatTime,
  formatTokens,
  terminalColumns,
  visibleWidth,
  withActor,
  type Colors,
} from './format.ts';
import type { ConfiguredModel, FinishedStep, ReplayNotice, ShownEvent } from './list-model.ts';

/** Step labels stay one glanceable line; the report holds the full text. */
const MAX_STEP_LABEL_COLUMNS = 72;
/** Recording model labels stay on one bounded terminal line. */
const MAX_RECORDED_MODEL_COLUMNS = 120;
/** A clipped step line keeps at least this much of its label, however narrow the terminal. */
const MIN_STEP_LABEL_COLUMNS = 24;
/** Columns a step line spends around its label: the quotes and the space before the tail. */
const LABEL_CHROME = 3;
/** A finished model turn. */
const F_MODEL = '•';
/** A tool call the model made. */
const F_TOOL = '›';
const F_INPUT = '↑';
const F_OUTPUT = '↓';
/** Columns the ` · ` between a turn's timing and its reasoning excerpt takes. */
const REASONING_SEPARATOR_WIDTH = 3;
/** A narrower clip than this hides more than it says; the excerpt is dropped instead. */
const MIN_REASONING_COLUMNS = 24;

/** One-line, quoted step label; `maxColumns` clips it further to fit a row. */
export function quotedLabel(label: string, maxColumns = MAX_STEP_LABEL_COLUMNS): string {
  const max = Math.min(MAX_STEP_LABEL_COLUMNS, Math.max(MIN_STEP_LABEL_COLUMNS, maxColumns));
  return `"${fitColumns(collapseText(label), max)}"`;
}

export interface StepLineOptions {
  /** Text before the api, naming the test when the line prints away from it. */
  readonly context?: string;
  /** Printed width the line may take; the label is clipped so the tail stays on the row. */
  readonly maxWidth?: number;
}

/**
 * One finished agent step: outcome glyph, api, quoted label, then duration,
 * model calls, and a non-passed status.
 */
export function stepLine(pc: Colors, step: FinishedStep, options: StepLineOptions = {}): string {
  const glyph = step.status === 'passed' ? pc.green(F_CHECK) : pc.red(F_CROSS);
  const calls =
    step.modelCalls > 0 ? ` · ${step.modelCalls} model call${step.modelCalls === 1 ? '' : 's'}` : '';
  const outcome = step.status === 'passed' ? '' : ` ${step.status}`;
  const head = `${glyph} ${options.context ?? ''}${pc.dim(withActor(step.actor, step.api))} `;
  const tail = pc.dim(`${formatTime(step.durationMs)}${calls}${outcome}`);
  const room =
    options.maxWidth === undefined
      ? undefined
      : options.maxWidth - visibleWidth(head) - visibleWidth(tail) - LABEL_CHROME;
  return `${head}${quotedLabel(step.label, room)} ${tail}`;
}

/** What Enter does at an `e2e run --step` prompt: it runs every step on it, or resumes the test at a pause. */
function enterDoes(prompt: StepPrompt): string {
  if (prompt.steps[0].step.kind === 'pause') {
    return 'resume';
  }

  return prompt.steps.length === 1 ? 'run this step' : `run these ${prompt.steps.length} steps`;
}

/** The prompt's other keys, in `--watch`'s words. */
const STEP_KEYS = [
  ['n', 'run this test without holding steps'],
  ['a', 'run all without holding steps'],
  ['q', 'quit'],
] as const;

/** Returns the keys offered besides Enter. `n` and `a` require held steps. */
function promptKeys(prompt: StepPrompt): readonly (readonly [key: string, does: string])[] {
  return prompt.holdSteps ? STEP_KEYS : STEP_KEYS.filter(([key]) => key === 'q');
}

/** Where a held step was called from, as `file:line`, or nothing. */
function promptSource(step: HeldStep): string {
  const { source } = step;
  return source === undefined ? '' : `${bounded(source.file)}:${source.line}`;
}

/** Formats a held step or pause with its call site for a plain text prompt. */
function heldCall(step: HeldStep): string {
  const source = promptSource(step);
  const call = step.kind === 'pause' ? `${step.api}()` : `${step.api} ${quotedLabel(step.label)}`;
  return source === '' ? call : `${call} (${source})`;
}

/**
 * A held step's prompt for the live window, under its test: the steps
 * waiting, one row each, then what to press, as `--watch` says it. Labels
 * are clipped so each call site stays on its row. The keys are one short
 * line, or every key once `h` asked for them.
 */
export function stepPromptRows(pc: Colors, prompt: StepPrompt, options: { readonly maxWidth: number }): string[] {
  const rows = prompt.steps.map(({ step, number }) => {
    const head = `${pc.bold(pc.cyan(`▶ step ${number}`))}  ${pc.dim(step.api)} `;
    const source = promptSource(step);
    const tail = source === '' ? '' : `  ${pc.dim(source)}`;
    if (step.kind === 'pause') {
      return `${pc.bold(pc.cyan('▶ paused'))}  ${pc.dim(`${step.api}()`)}${tail}`;
    }
    const room = options.maxWidth - visibleWidth(head) - visibleWidth(tail) - LABEL_CHROME;
    return `${head}${quotedLabel(step.label, room)}${tail}`;
  });
  const press = (key: string, does: string): string => `${pc.dim('press')} ${pc.bold(key)} ${pc.dim(`to ${does}`)}`;
  const enter = press('enter', enterDoes(prompt));
  const keys = prompt.help
    ? [enter, ...promptKeys(prompt).map(([key, does]) => press(key, does)), press('h', 'hide help')]
    : [`${enter}${pc.dim(',')} ${press('h', 'show help')}${pc.dim(',')} ${press('q', 'quit')}`];
  return [...rows, ...keys.map((line) => `  ${line}`)];
}

/** A held step's prompt as one plain line, for a terminal with no live window to show it in. */
export function stepPromptLine(prompt: StepPrompt): string {
  const [first] = prompt.steps;
  const numbers = prompt.steps.map(({ number }) => number).join(', ');
  const steps = prompt.steps.map(({ step }) => heldCall(step));
  const keys = [`enter to ${enterDoes(prompt)}`, ...promptKeys(prompt).map(([key, does]) => `${key} to ${does}`)].join(', ');
  const at = first.step.kind === 'pause' ? 'in' : `at ${prompt.steps.length === 1 ? 'step' : 'steps'} ${numbers} of`;
  return `paused ${at} ${bounded(first.step.title)} [${bounded(first.step.target)}]: ${steps.join('; ')} · press ${keys}`;
}

/**
 * A held step's prompt as plain lines for a reader with no terminal
 * (`e2e run --step`, or a pause, driven by later commands): the test, the
 * steps waiting with their call sites, the screen they wait on, and the
 * commands that go on. `screen` is undefined if it couldn't be read or the
 * wait ended.
 */
export function stepPromptText(prompt: StepPrompt, screen: string | undefined): string {
  const [first] = prompt.steps;
  const pause = first.step.kind === 'pause';
  const numbers = prompt.steps.map(({ number }) => number).join(', ');
  const at = pause ? 'in' : `before ${prompt.steps.length === 1 ? 'step' : 'steps'} ${numbers} of`;
  const lines = [`Paused ${at} ${bounded(first.step.title)} [${bounded(first.step.target)}]:`];
  for (const { step } of prompt.steps) {
    lines.push(`  ${heldCall(step)}`);
  }
  if (screen === undefined) lines.push('Screen: could not be read.');
  else lines.push('Screen:', ...screen.split('\n').map((line) => `  ${bounded(line)}`));

  const next = pause ? 'to resume the test' : `to run ${prompt.steps.length === 1 ? 'it' : 'them'}`;
  let rest = '';

  if (prompt.holdSteps) {
    rest = pause ? 'e2e run --step rest to resume it without holding any more steps, ' : 'e2e run --step rest to run the rest, ';
  }

  lines.push(`Next: e2e run --step next ${next}, ${rest}or e2e run --step stop to end the run.`);
  return `${lines.join('\n')}\n`;
}

/** Recording mismatches under one test, deduplicated across its attempts. */
export function replayNotices(attempts: readonly (readonly StepRecord[])[], configured: ConfiguredModel | undefined): ReplayNotice[] {
  if (configured === undefined) return [];
  const notices = new Map<string, ReplayNotice>();
  for (const steps of attempts) {
    for (const step of steps) {
      if (step.agent !== undefined && step.agent !== configured.agent) continue;
      const source = step.cache?.recordedBy;
      if (source === undefined || step.cache?.replayedActions === 0) continue;
      const label = modelLabel({ provider: source.provider, id: source.model });
      if (label === configured.label) continue;
      const key = JSON.stringify([step.cache?.entry ?? [step.index, step.api, step.label], source.provider, source.model]);
      notices.set(key, { api: step.api, label: step.label, source });
    }
  }
  return [...notices.values()];
}

/** A recording mismatch under its test in the file block. */
export function replayLine(pc: Colors, notice: ReplayNotice): string {
  const label = modelLabel({ provider: notice.source.provider, id: notice.source.model });
  return `${pc.dim(notice.api)} ${quotedLabel(notice.label)} ${pc.dim(`replayed · recorded with ${fitColumns(collapseText(label), MAX_RECORDED_MODEL_COLUMNS)}`)}`;
}

/**
 * `(↑in ↓out)` for one model call, the total when only that is known, or
 * nothing when the provider reported no usage.
 */
function tokenSplit(event: ShownEvent): string {
  if (event.inputTokens !== undefined && event.outputTokens !== undefined) {
    return ` (${F_INPUT}${formatTokens(event.inputTokens)} ${F_OUTPUT}${formatTokens(event.outputTokens)})`;
  }
  return event.count !== undefined && event.count > 0 ? ` (${formatTokens(event.count)} tokens)` : '';
}

/**
 * One model turn or tool call under the current step. A tool call reads as
 * the act it performed when the engine described it, else as the tool name
 * (`tool:` prefixes come from executor tool accounting). A model turn the
 * model reasoned its way through appends an excerpt of that reasoning,
 * clipped to the row: why it acted, not just that it did.
 */
export function eventLine(pc: Colors, event: ShownEvent, options: { maxWidth?: number } = {}): string {
  if (event.kind === 'model') {
    const head = `${F_MODEL} Thinking (${formatTime(event.durationMs)})${tokenSplit(event)}`;
    const reasoning = reasoningExcerpt(event.reasoning, visibleWidth(head), options.maxWidth);
    return pc.dim(reasoning === undefined ? head : `${head} · ${reasoning}`);
  }
  const name = sanitizeText(event.name ?? 'engine').replace(/^tool:/, '');
  const act = event.detail === undefined ? name : sanitizeText(collapseText(event.detail));
  const failed = event.status === 'passed' ? '' : ` ${pc.red(F_CROSS)}`;
  return `${pc.dim(`${F_TOOL} ${truncateUtf8(act, 60)} (${formatTime(event.durationMs)})`)}${failed}`;
}

/**
 * The one-line form of a turn's reasoning for its Thinking row, or undefined
 * when the row has no room worth reading at.
 */
function reasoningExcerpt(reasoning: string | undefined, headWidth: number, maxWidth?: number): string | undefined {
  if (reasoning === undefined) return undefined;
  const room = (maxWidth ?? terminalColumns()) - headWidth - REASONING_SEPARATOR_WIDTH;
  if (room < MIN_REASONING_COLUMNS) return undefined;
  return fitColumns(collapseText(reasoning), room);
}
