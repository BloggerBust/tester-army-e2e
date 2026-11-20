/**
 * Loop guards: pure detectors over the tool-call transcript that catch an
 * executor loop going in circles before the budget does. Ported from the
 * shape proven in production — a wandering model repeats itself long before
 * it runs out of calls, and every repeated turn is spent money.
 *
 * A guard never invents a verdict: a warning injects a notice the model can
 * react to, and a stop forces the conclusion tool so the model still writes
 * its own summary. Budgets remain the outer bound either way.
 */

import type { ModelMessage } from 'ai';
import { realmSlot } from '../internal/realm-slot.ts';
import { GRAMMAR_TOOL_NAMES } from './action-names.ts';
import { reportsScreenChange, toolResultTexts } from './screen-update.ts';

/** One tool call as identity: the name plus its exact serialized input. */
export interface GuardToolCall {
  readonly toolName: string;
  readonly input: string;
  /** Set on a call to a waiting tool whose result showed the listing or the tabs change; not part of the identity. */
  readonly sawChange?: true;
}

export type LoopGuardVerdict =
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'warn' | 'stop';
      readonly reason: string;
      /** True when the calls are looks of the waiting tools (the built-in observe and screenshot): a wait, not yet a circle. */
      readonly waiting?: boolean;
      /** Names the wait a warning belongs to, so each wait in a step is warned once; the reason stays the same. */
      readonly key?: string;
    };

/** Longest cycle period the detector considers. */
const MAX_CYCLE_PERIOD = 4;

/**
 * Guard thresholds. Identical-call (period 1) counts are consecutive
 * repetitions of one call; cycle (period 2..4) counts are whole repetitions
 * of the sequence. Each warns first, then forces the conclusion.
 */
export interface LoopGuardThresholds {
  readonly repeatWarn: number;
  readonly repeatStop: number;
  /**
   * Calls in a row to tools marked with `markWaitingTool` (the built-in
   * `observe` and plain `screenshot`), in any order, since the last one whose
   * result showed a change: reading the screen again while a save or a load
   * is still in progress is waiting, not a loop, so it gets more room than an
   * action.
   */
  readonly observeRepeatWarn: number;
  readonly observeRepeatStop: number;
  /** Calls in a row to waiting tools however many showed a change: a screen that ticks forever still ends the wait, with a warning first. */
  readonly waitingWarn: number;
  readonly waitingStop: number;
  readonly cycleWarn: number;
  readonly cycleStop: number;
  /** Consecutive failed tool results that warn, then force the conclusion. */
  readonly failureWarn: number;
  readonly failureStop: number;
}

/** The thresholds the built-in agent ships with. */
export const DEFAULT_LOOP_GUARD_THRESHOLDS: LoopGuardThresholds = {
  repeatWarn: 3,
  repeatStop: 5,
  observeRepeatWarn: 6,
  observeRepeatStop: 10,
  waitingWarn: 12,
  waitingStop: 20,
  cycleWarn: 2,
  cycleStop: 3,
  failureWarn: 3,
  failureStop: 5,
};

/** A tool as the guard sees it: only its handler matters. */
interface GuardedTool {
  readonly execute?: unknown;
}

/**
 * Set on the handler of a tool that only waits on the screen; see
 * `observeRepeatWarn`. A registry symbol, not module state: a custom executor
 * can get the built-in tools from another installed copy of this package.
 */
const waitingHandler = realmSlot<true>('e2e.agent.waiting-handler.v1');

/**
 * Marks a tool as one that only reads the screen again, so a run of calls to
 * it gets the waiting thresholds. Only the built-in `observe` and the plain
 * `screenshot` (not the variant that saves a file) are marked.
 * The mark is on its handler, not the tool object: a caller's own tool under
 * the same name, or the built-in tool with its `execute` replaced, may write
 * and keeps the ordinary thresholds.
 */
export function markWaitingTool<T extends GuardedTool>(tool: T): T {
  if (typeof tool.execute === 'function') waitingHandler.set(tool.execute, true);
  return tool;
}

/** The names under which a tool set offers a tool whose handler `markWaitingTool` marked. */
export function waitingToolNames(tools: Readonly<Record<string, GuardedTool>>): ReadonlySet<string> {
  return new Set(
    Object.entries(tools)
      .filter(([, tool]) => typeof tool.execute === 'function' && waitingHandler.get(tool.execute) === true)
      .map(([name]) => name),
  );
}

/**
 * Extracts the tool-call identity sequence from a model transcript,
 * excluding the conclusion tool: concluding attempts are never "loops".
 */
export function extractGuardCalls(
  messages: readonly ModelMessage[],
  concludeToolName: string,
  waiting: ReadonlySet<string> = new Set(),
  seen: Map<string, boolean> = new Map(),
  resultMessages: readonly ModelMessage[] = messages,
): GuardToolCall[] {
  // The calls come from the history the model reads; the looks' results may come from an earlier, uncut one.
  const moved = waiting.size === 0 ? new Set<string>() : waitsThatSawChange(resultMessages, waiting, seen);
  const calls: GuardToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName === concludeToolName) continue;
      calls.push({
        toolName: part.toolName,
        input: safeStringify(part.input),
        ...(moved.has(part.toolCallId) ? { sawChange: true as const } : {}),
      });
    }
  }
  return calls;
}

/**
 * The call ids of waiting tools whose result reported a change on screen.
 * A result is read once and its answer kept in `seen`: transcript compaction
 * later elides old full screens, lead line and all, and a look that showed
 * the listing come back must stay one.
 */
function waitsThatSawChange(messages: readonly ModelMessage[], waiting: ReadonlySet<string>, seen: Map<string, boolean>): Set<string> {
  const moved = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || !waiting.has(part.toolName)) continue;
      let changed = seen.get(part.toolCallId);
      if (changed === undefined) {
        changed = reportsScreenChange(toolResultTexts(part.output).join('\n'));
        seen.set(part.toolCallId, changed);
      }
      if (changed) moved.add(part.toolCallId);
    }
  }
  return moved;
}

/** The waiting notices' reasons: the same on every turn of a wait, so each wait is warned once. */
const WAITING_REASON = 'the screen was looked at several times in a row with no change';
const TICKING_REASON = 'the screen was looked at many times in a row while it kept changing';

/**
 * Checks the trailing calls for exact repetition (period 1) and short exact
 * cycles (periods 2..4). Identity includes the serialized input, so two taps
 * on different targets never count as a repeat — only literally re-issuing
 * the same work does. A trailing run of calls to the `waiting` tools is a
 * wait and is counted on its own, in calls and in any order; a window with
 * any other call in it gets the ordinary thresholds.
 */
export function checkLoopGuards(
  calls: readonly GuardToolCall[],
  thresholds: LoopGuardThresholds = DEFAULT_LOOP_GUARD_THRESHOLDS,
  waiting: ReadonlySet<string> = new Set(),
): LoopGuardVerdict {
  let warning: LoopGuardVerdict | undefined;
  const wait = trailingWait(calls, waiting);
  if (wait.looks >= thresholds.waitingStop) {
    return { kind: 'stop', reason: `the screen was looked at ${String(wait.looks)} times in a row while it kept changing` };
  }
  if (wait.unchanged >= thresholds.observeRepeatStop) {
    return { kind: 'stop', reason: `the screen was looked at ${String(wait.unchanged)} times in a row with no change` };
  }
  // Keyed by where the wait or its unchanged run began: a later wait in the step is warned again.
  const started = calls.length - wait.looks;
  if (wait.unchanged >= thresholds.observeRepeatWarn) {
    warning = { kind: 'warn', reason: WAITING_REASON, waiting: true, key: `wait@${String(calls.length - wait.unchanged)}` };
  } else if (wait.looks >= thresholds.waitingWarn) {
    warning = { kind: 'warn', reason: TICKING_REASON, waiting: true, key: `ticking@${String(started)}` };
  }
  for (let period = 1; period <= MAX_CYCLE_PERIOD; period += 1) {
    // A window of waiting calls alone is the wait above, not a circle.
    if (period <= wait.looks) continue;
    const repeats = trailingRepeats(calls, period);
    const [warnAt, stopAt] = period > 1 ? [thresholds.cycleWarn, thresholds.cycleStop] : [thresholds.repeatWarn, thresholds.repeatStop];
    if (repeats >= stopAt) {
      return { kind: 'stop', reason: describe(calls, period, repeats) };
    }
    if (repeats >= warnAt && warning === undefined) {
      warning = { kind: 'warn', reason: describe(calls, period, repeats) };
    }
  }
  return warning ?? { kind: 'clear' };
}

/**
 * The trailing run of calls to waiting tools: how many there are, and how
 * many came after the last one that showed a change.
 */
function trailingWait(calls: readonly GuardToolCall[], waiting: ReadonlySet<string>): { readonly looks: number; readonly unchanged: number } {
  let looks = 0;
  let unchanged: number | undefined;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index]!;
    if (!waiting.has(call.toolName)) break;
    if (call.sawChange === true && unchanged === undefined) unchanged = looks;
    looks += 1;
  }
  return { looks, unchanged: unchanged ?? looks };
}

/** How many times the trailing window of `period` calls repeats consecutively. */
function trailingRepeats(calls: readonly GuardToolCall[], period: number): number {
  if (calls.length < period) return 0;
  // A period-p cycle must not be a disguised shorter cycle: "A A A A" matches
  // period 2 as well, but period 1 owns it and applies the stricter policy.
  if (period > 1 && isUniformWindow(calls, period)) return 0;
  const same = (a: GuardToolCall | undefined, b: GuardToolCall | undefined): boolean =>
    a !== undefined && b !== undefined && a.toolName === b.toolName && a.input === b.input;
  let repeats = 1;
  for (let offset = period; calls.length - offset - period >= 0; offset += period) {
    let matches = true;
    for (let index = 0; index < period; index += 1) {
      if (!same(calls[calls.length - period + index], calls[calls.length - offset - period + index])) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
    repeats += 1;
  }
  return repeats;
}

/** True when the trailing window consists of one identical call repeated. */
function isUniformWindow(calls: readonly GuardToolCall[], period: number): boolean {
  const first = calls[calls.length - period];
  if (first === undefined) return false;
  for (let index = 1; index < period; index += 1) {
    const call = calls[calls.length - period + index];
    if (call === undefined || call.toolName !== first.toolName || call.input !== first.input) {
      return false;
    }
  }
  return true;
}

function describe(calls: readonly GuardToolCall[], period: number, repeats: number): string {
  const names = calls
    .slice(calls.length - period)
    .map((call) => call.toolName)
    .join(', ');
  return period === 1
    ? `the same "${names}" call with identical input was issued ${repeats} times in a row`
    : `the same ${period}-call sequence (${names}) repeated ${repeats} times with identical inputs`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/** One tool result as the guard reads it: the text the model saw, and whether it reports a failure. */
export interface GuardToolResult {
  readonly text: string;
  readonly failed: boolean;
}

/**
 * Extracts every tool result in a transcript, in order. A text result is
 * read for the failure shape; a result with a screenshot attached counts as
 * its text, lead first. A result the SDK refused before dispatch (a tool the
 * step does not offer, an input outside the closed schema) is a failure by
 * construction: nothing ran, and the turn is spent. The conclusion tool's
 * own text (an accepted verdict, a blocked one sent back for its code) is
 * not an action and is skipped, but a refused conclusion counts: the repeat
 * guard never sees conclusion calls, so this streak is the only bound short
 * of the turn budget on a model that resends one the schema turns away. A
 * structured result is a project tool's own shape and
 * says nothing about failure.
 */
export function extractToolResults(messages: readonly ModelMessage[], concludeToolName: string): GuardToolResult[] {
  const results: GuardToolResult[] = [];
  for (const message of messages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      if (output.type === 'error-text') {
        results.push({ text: output.value, failed: true });
        continue;
      }
      if (part.toolName === concludeToolName) continue;
      const texts = toolResultTexts(output);
      if (texts.length === 0) continue;
      const text = texts.join('\n');
      results.push({ text, failed: isFailedResult(part.toolName, text) });
    }
  }
  return results;
}

/**
 * Whether a tool result reports its action failing, by the first line's
 * shape: `Action failed: …` from the loop's guard and `Tool "x" failed: …`
 * from a project tool that threw, for any tool; for a grammar tool also its
 * own failure lead, the tool's name and what it was aimed at before
 * `failed:` (`tap #n6 failed: …`, `tap_at (30, 30) failed: …`). A grammar
 * success leads with a capital, so text the model typed into one never reads
 * as a failure, and a project tool's own text (`build failed: 2 red`) is its
 * result, not a failed call.
 */
export function isFailedResult(toolName: string, text: string): boolean {
  const first = text.split('\n', 1)[0] ?? '';
  if (/^(?:Action |Tool "[^"]*" )failed: /.test(first)) return true;
  return GRAMMAR_TOOL_NAMES.has(toolName) && /^[a-z_]+(?: .*)? failed: /.test(first);
}

/**
 * Checks the trailing run of failed results. Different targets or inputs do
 * not save a streak: five failures in a row say the approach is wrong, not
 * that the last id was. Warns first, then forces the conclusion.
 */
export function checkFailureStreak(
  results: readonly GuardToolResult[],
  thresholds: LoopGuardThresholds = DEFAULT_LOOP_GUARD_THRESHOLDS,
): LoopGuardVerdict {
  let streak = 0;
  for (let index = results.length - 1; index >= 0 && results[index]!.failed; index -= 1) streak += 1;
  if (streak >= thresholds.failureStop) {
    return { kind: 'stop', reason: `the last ${String(streak)} actions failed in a row` };
  }
  if (streak >= thresholds.failureWarn) {
    return { kind: 'warn', reason: `the last ${String(streak)} actions failed in a row` };
  }
  return { kind: 'clear' };
}
