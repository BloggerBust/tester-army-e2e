/** Attempt-scoped step timeline. */

import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentError, isAgentError } from '../agent/error.ts';
import type { ReplayHandOffReason } from '../agent/executor.ts';
import type { CacheWrite } from '../cache/context.ts';
import type { TraceReplayMissReason } from '../cache/decide.ts';
import { MAX_TRACE_DESCRIPTOR_CHARS, type RecordedModel, type DerivedReason } from '../cache/trace.ts';
import { readRecordedModel } from '../cache/trace-fields.ts';
import { bound } from '../internal/text.ts';
import { markAbandonedRejection, relocateStack } from '../internal/abandoned.ts';
import { withAiTraceStep } from '../internal/ai-trace.ts';
import { classifyError, redactErrorDetails, serializeError, TestError, withHint, type SerializedError } from '../internal/errors.ts';
import { timestamp } from '../internal/ids.ts';
import { abortError, cancelledError, withAbort } from '../internal/time.ts';
import { sourceLocation, type SourceLocation } from '../internal/source.ts';
import type { GuestRecord } from './guest-steps.ts';
import type { AppLogEntry, AppLogSource } from '../engine/index.ts';
import { APP_LOG_LIMITS } from '../engine/session.ts';
import type { AppEvent } from '../engine/surface.ts';
import { compareScreens, type ScreenText, type StepScreen } from './step-screens.ts';
import { insidePollRead, pollReadSignal } from '../expect/poll-scope.ts';
import { processSecrets, registerProviderKeys } from './secrecy.ts';

/** The closed step kind set; the type is derived from it, so the two cannot drift. */
export const STEP_KINDS = ['agent', 'locator', 'assertion', 'screen', 'app', 'session', 'resource', 'step'] as const;

/** The api of a step the test names with `test.step`, the one step of kind `step`. */
export const TEST_STEP_API = 'test.step';

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Child event of one public step: polls, model calls, policy decisions.
 * `tool-proposal` (report-1) belongs to the planning tier and is not emitted
 * by this milestone.
 */
export interface StepEvent {
  /** `navigation` is where the app went on its own (a navigation the engine did not start, a tab, a frame), in `detail`. */
  kind: 'poll' | 'observation' | 'model' | 'policy' | 'engine' | 'schema' | 'navigation';
  /**
   * When the event began, not when it was recorded. A `model` event carries
   * the moment the request went out even when the executor reports the turn
   * after the tool calls it made, so events sorted by `startedAt` are in
   * causal order while `events` itself is in recording order.
   */
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  name?: string;
  count?: number;
  /**
   * Prompt and completion tokens of one model call, when the provider
   * reported both; `count` is their sum. Lets a live reporter show the split.
   */
  inputTokens?: number;
  outputTokens?: number;
  bytes?: number;
  decision?: 'allowed' | 'denied';
  code?: string;
  /**
   * Redacted human prose for what the event did — `tap button "Approve"`,
   * `fill secret "password" into textbox "Password"`. Driver action events
   * carry one so a live reporter can render the act without a side lookup;
   * secret values never appear (the name stands in), and the text is bounded.
   */
  detail?: string;
  /**
   * Bounded, redacted excerpt of the reasoning a model turn produced, when
   * the provider returns one. Lets a live reporter show why the model acted,
   * not just that it did. Secrets never reach model input, and the attempt
   * redactor runs over the excerpt regardless; the full text lives in the AI
   * trace, never here.
   */
  reasoning?: string;
}

/** Required accounting for every agent step. */
export interface StepMetrics {
  modelCalls: number;
  actionSteps: number;
  observationBytes: number;
  contextBytes: number;
  ledgerBytes: number;
  /** Largest masked image sent to the model in this step, in bytes. */
  pixelBytes?: number;
}

/**
 * Why a vision step fell back to tree-only input. Pixel evidence degrades
 * rather than failing the step.
 */
export type VisionDegradation = 'MASKING_UNPROVEN' | 'UNSUPPORTED_CAPABILITY';

/** Model provenance and usage for one model-backed step. */
export interface StepModelInfo {
  provider: string;
  model: string;
  endpoint: string;
  adapterVersion: string;
  policyVersion: string;
  calls: number;
  tokenAccounting: 'provider' | 'adapter-upper-bound';
  peakTokensPerCall: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens the provider served from its prompt cache and wrote to it,
   * summed over the step's calls; present only when the provider reports the
   * split. Cached reads are part of `inputTokens`, not in addition to it.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * How the trace cache participated in one agent step. `self-finalized` means
 * the full trace replayed and the step passed with zero model calls;
 * `agent-concluded` means a replayed prefix handed the step to the executor;
 * `missed` means the executor ran the step from the top.
 */
export interface StepCacheInfo {
  mode: 'self-finalized' | 'agent-concluded' | 'missed';
  /** The miss or hand-off reason token; absent on `self-finalized`. */
  reason?: TraceReplayMissReason | ReplayHandOffReason;
  /**
   * On a `gap` at a typed value: the rule that made the value this run's
   * data rather than the flow's. Absent for a gap at a project tool.
   */
  derived?: DerivedReason;
  /**
   * Why a passing step that ran live was still not recorded, when the cause
   * is the call itself: `param-collision` when a `unique()` value equals, is
   * spelled inside, or is the encoded form of another param's value, so the
   * recording could not tell which param a recorded input came from.
   */
  notRecorded?: 'param-collision';
  replayedActions: number;
  totalActions: number;
  /** The step's cache key, which names its entry file (`<cache.dir>/<entry>.json` in the file store). */
  entry?: string;
  /**
   * Why the replay missed or handed off, past what the reason token says:
   * the recorded action it stopped at and what went wrong there, or the
   * screen the recording started on against the one the step did.
   */
  detail?: string;
  /** Configured model when the consulted entry was recorded; absent on older entries. */
  recordedBy?: RecordedModel;
}

/** The cache detail as the report keeps it: what `agent.act()` returns, and what became of the recording once the attempt settled. */
export type StepCacheRecord = StepCacheInfo & {
  /** Set when the attempt ends, so a step's own `result.cache` never has it; see `CacheWrite`. */
  write?: CacheWrite;
};

/** Agent-specific step detail attached while the step is still running. */
export interface StepAgentDetails {
  metrics?: StepMetrics;
  model?: StepModelInfo;
  cache?: StepCacheInfo;
  /** Absent when the step failed before capturing an observation. */
  observationRevision?: string;
  /** True when at least one semantic observation in the step was truncated. */
  observationTruncated?: boolean;
  /** Absent when capture failed before a judgment could be requested. */
  explanation?: string;
  /** True when masked pixel evidence was model input, not just an artifact. */
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  /**
   * True when `vision: 'only'` withheld the semantic tree, leaving the masked
   * screenshot as the model's only evidence. `metrics.observationBytes` is then
   * zero, because the observation contributed nothing to the request.
   */
  visionOnly?: boolean;
  /** The step's last model turns, bounded; see `StepTurn`. */
  turns?: StepTurn[];
}

/**
 * One model turn of an agent step, as the report keeps it: the tool calls
 * the model made and what came back, each bounded. Enough to read why the
 * step ended where it did without the full transcript.
 */
export interface StepTurn {
  /** One-based turn number within the step. */
  index: number;
  /** `tap({"target":"n19"})`, one per tool call, arguments clipped. */
  calls: string[];
  /** The tool results of the turn, clipped; a screen diff reads as its first lines. */
  outcome: string;
}

export interface StepRecord {
  id: string;
  index: number;
  kind: StepKind;
  api: string;
  label: string;
  /**
   * The session the step ran on, when it is not the test's own: one the test
   * drives beside it through `launch()`, named in the order they joined it
   * (`launch-1`), which is when the test opened one, or first used one
   * opened outside it. Absent for a step of the test's own session.
   */
  actor?: string;
  /** The index of the `test.step` the step ran inside; absent for a step outside one. */
  parent?: number;
  /** The test line the step was called from; absent when no project line was on the stack. */
  source?: SourceLocation;
  status: 'passed' | 'failed' | 'blocked' | 'timed-out' | 'cancelled';
  startedAt: string;
  durationMs: number;
  observationRevision?: string;
  /** True when at least one semantic observation in the step was truncated. */
  observationTruncated?: boolean;
  explanation?: string;
  visionInput?: boolean;
  visionDegraded?: VisionDegradation;
  visionOnly?: boolean;
  viewport?: { width: number; height: number; scale: number };
  metrics?: StepMetrics;
  cache?: StepCacheRecord;
  events: StepEvent[];
  /** The model turns of an agent step, most recent last, bounded. */
  turns?: StepTurn[];
  model?: StepModelInfo;
  /** The configured agent an agent step ran with, by name. */
  agent?: string;
  /** The hook the step ran in; absent for a step of the test body. */
  phase?: StepPhase;
  /** How the last screen the step saw differs from the step before's; absent when it saw none. */
  screen?: StepScreen;
  error?: SerializedError;
  artifacts: string[];
}

/** Whether a step ran on the test's own session, not on one the test drives beside it. */
export function isOwnStep(step: Pick<StepRecord, 'actor'>): boolean {
  return step.actor === undefined;
}

/** The hooks a step can run in outside the test body. */
export type StepPhase = 'beforeEach' | 'afterEach';

/**
 * Live progress notification for one step, streamed to reporters as the step
 * runs. Derived from the same records the report persists; the report stays
 * the canonical record.
 */
/** The work a running agent step can be waiting on; see `StepProgress`. */
export type StepActivity = 'observe' | 'model' | 'action';

/** IDs join live progress to the report. Step indexes are local to each test or serial member. */
interface StepProgressIdentity {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly stepId: string;
  readonly stepIndex: number;
  /** The session the step ran on when it is not the test's own; see `StepRecord.actor`. */
  readonly actor?: string;
  /** The id of the `test.step` the step runs inside; see `StepRecord.parent`. */
  readonly parentStepId?: string;
}

/** One progress payload before the recorder attaches its identity. */
export type StepProgressFact =
  | {
      readonly phase: 'start';
      readonly kind: StepKind;
      readonly api: string;
      readonly label: string;
      /** Where the test called the step, as its record has it; absent when the call site is not in the project. */
      readonly source?: SourceLocation;
    }
  | {
      readonly phase: 'end';
      readonly kind: StepKind;
      readonly api: string;
      readonly label: string;
      readonly status: StepRecord['status'];
      readonly durationMs: number;
      readonly modelCalls: number;
      /** The same redacted error the finished step records. */
      readonly error?: SerializedError;
      readonly explanation?: string;
    }
  | { readonly phase: 'event'; readonly api: string; readonly event: StepEvent }
  /**
   * What the running step is waiting on right now: a device or browser being
   * read (`observe`), an action landing (`action`), or a model turn
   * (`model`). Emitted as each begins; the matching `event` reports its end.
   * On a device a snapshot or a tap takes seconds, so between events the
   * model is not always the one working.
   */
  | { readonly phase: 'activity'; readonly api: string; readonly activity: StepActivity }
  /**
   * The trace cache took the step (`active`), or handed it to the model after
   * a replay that could not finish it; a step the replay finishes ends while
   * the cache has it. While the cache has the step, recorded actions execute
   * with no model in the loop, so the wait between events is on the app
   * settling, not on a model turn.
   */
  | { readonly phase: 'replay'; readonly api: string; readonly active: boolean };

/** Every runner-produced phase carries identity; optional for consumers of older event streams. */
export type StepProgress = StepProgressFact & { readonly identity?: StepProgressIdentity };

/** Per-step options for `StepRecorder.run`. */
export interface StepRunOptions {
  /**
   * Whether the step checks state rather than producing it: a deterministic
   * assertion, a locator wait, or an agent judgment. Only such a step passing
   * can confirm a staged action trace (cache/context.ts) — an `agent.act`
   * passing is the executor's opinion of its own work, and an `app` or
   * `locator` action passing proves only that the action could be performed.
   * Declared where the step is minted, so the rule cannot drift from the api
   * names.
   */
  readonly verifies?: boolean;
  /** The configured agent an agent step runs with, recorded on the step. */
  readonly agent?: string | undefined;
}

/**
 * How a step that threw ended. A blocked verdict is a distinct outcome, not a
 * product failure: the step's error names what stood in the way, and the
 * report says so.
 */
function failedStatus(error: { readonly code: string }, cause: unknown): StepRecord['status'] {
  if (error.code === 'CANCELLED') return 'cancelled';
  return isAgentError(cause) && cause.blocked ? 'blocked' : 'failed';
}

/** How many causes down a thrown error is redacted; a chain is rarely three deep. */
const MAX_REDACTED_CAUSES = 8;

/** Replaces secret values in the message, stack, and details of a thrown error and of the causes under it, keeping each error's identity. */
function redactErrorInPlace(thrown: unknown, redact: (text: string) => string): void {
  let error: unknown = thrown;
  for (let depth = 0; error instanceof Error && depth < MAX_REDACTED_CAUSES; depth += 1) {
    try {
      error.message = redact(error.message);
      if (error.stack !== undefined) error.stack = redact(error.stack);
      // An agent error keeps its message twice: as `message` and as `explanation`.
      if (isAgentError(error)) (error as { explanation: string }).explanation = redact(error.explanation);
      redactErrorDetails(error, redact);
    } catch {
      // A frozen error keeps its text; nothing more can be done to it here.
    }
    error = error.cause;
  }
}

/**
 * A failed model call, rebuilt as this copy's own agent error with its code,
 * its `blocked` flag, and its text redacted, and no cause. Whoever catches a
 * step's error gets this: the cause is the provider SDK's error, whose own
 * fields (a response body, the request) no redaction reaches, and a provider
 * may quote the key back in them. An agent error from another installed copy
 * of core is rebuilt the same way. Every other error is left to the caller.
 */
function modelFailure(cause: unknown, redact: (text: string) => string): AgentError | undefined {
  if (!isAgentError(cause)) return undefined;
  if (cause.code !== 'MODEL_PROVIDER_FAILED' && cause.code !== 'CONTEXT_OVERFLOW' && cause.code !== 'MODEL_OUTPUT_INVALID') {
    return undefined;
  }
  const error = new AgentError(cause.code, redact(cause.explanation), {
    blocked: cause.blocked,
    ...(cause.screenshot === undefined ? {} : { screenshot: cause.screenshot }),
  });
  if (cause.stack !== undefined) error.stack = redact(cause.stack);
  return error;
}

export interface StepRecorderOptions {
  /** The report-owning attempt; serial members share their group's attempt identity. */
  readonly attempt?: { readonly id: string; readonly index: number };
  /** Caps events retained per step (resolved limits.maxEventsPerStep). */
  readonly maxEventsPerStep?: number;
  /** Live progress sink; omitted in contexts with no reporter to feed. */
  readonly onProgress?: (progress: StepProgress) => void;
  /** Takes each progress with the record it is of, for the recorder of a session whose steps a test's recorder mirrors (`run/guest-steps.ts`). */
  readonly mirror?: (progress: StepProgress, record: StepRecord) => void;
  /** The project root; with it, every step and step error names the test line it came from. */
  readonly projectRoot?: string;
  /** Replaces secret values in a step's label, and in its error's message and details, before the record keeps them. */
  readonly redact?: (text: string) => string;
  /** Cuts every running step when it aborts: the step fails with the signal's error and its body is abandoned. */
  readonly signal?: AbortSignal;
  /**
   * Throws a failed step's error classified and redacted, as its record
   * keeps it: a program with no report around it reads the thrown error
   * itself, so it must carry a `code`, and an engine's message quotes the
   * screen. Off in a run, whose report classifies and redacts.
   */
  readonly redactThrown?: boolean;
  /**
   * How many finished steps the recorder keeps, oldest dropped first. A run
   * keeps them all for its report; a program's session has no report and
   * may take millions of steps. Step indexes go on counting.
   */
  readonly retainSteps?: number;
  /**
   * Set `hold` to wait at held steps and pauses. Without it, a pause returns
   * right away.
   */
  readonly hold?: RecorderHold;
}

/** Options for holding an attempt at steps and pauses. */
type RecorderHold = {
  /**
   * Waits at each `screen.pause()` call, and before each step when `steps` is
   * set.
   *
   * - If the promise resolves, the attempt continues.
   * - If it rejects, the attempt fails.
   *
   * The signal is aborted if the wait is abandoned.
   */
  readonly ask: (request: StepHoldRequest, signal: AbortSignal) => Promise<void>;
  /**
   * Set `steps` to wait at `ask` before each top-level step in a holdable
   * phase (`e2e run --step`). The step isn't recorded until `ask` resolves.
   * Otherwise, only `screen.pause()` waits at `ask`.
   */
  readonly steps: boolean;
};

/** A step or pause about to wait at `StepRecorderOptions.hold`: what the person stepping through the test is shown. */
export interface StepHoldRequest {
  /**
   * The kind of wait. `step` means a step is held before it runs. `pause`
   * means the test has reached `screen.pause()`.
   */
  readonly kind: 'step' | 'pause';
  /** Expected position in the trace, from 1. A pause uses 0. */
  readonly number: number;
  readonly api: string;
  /** Already redacted. */
  readonly label: string;
  readonly source?: SourceLocation;
}

/** A step call waiting at its hold, kept so a body that returns without awaiting it still fails as `STEP_NOT_AWAITED`. */
interface HeldCall {
  /** The `test.step` the call was made in, kept for a call recorded from outside it. */
  readonly group: ActiveGroup | undefined;
  readonly kind: StepKind;
  readonly api: string;
  readonly label: string;
  readonly stack: string | undefined;
  readonly options: StepRunOptions;
  readonly cancel: AbortController;
  promise: Promise<unknown>;
}

/**
 * A pause waiting at `hold`. If the body returns without awaiting it, the
 * test fails with `STEP_NOT_AWAITED`.
 */
interface HeldPause {
  readonly api: string;
  /** The `owner` the pause was started by. */
  readonly owner: string;
  readonly stack: string | undefined;
  readonly cancel: AbortController;
  promise: Promise<void>;
}

/** Frames kept when a step captures where it was called from; the user's line is a few frames up. */
const STEP_STACK_FRAMES = 20;

/**
 * The stack at a step's start, or nothing without a project root to read it
 * against. Every step pays the capture, since the failing one is not known
 * until it fails, and a report that names the line is worth it. The stack
 * outlives the source it yields: a step the body abandoned reports its
 * failure from the line it was called on.
 */
function stepStack(projectRoot: string | undefined): string | undefined {
  if (projectRoot === undefined) return undefined;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = STEP_STACK_FRAMES;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/**
 * One line the app logged during an attempt, redacted and bounded: where it
 * came from, how bad it was, when, and the index of the step that was running
 * (else the one that started last); absent before the attempt's first step.
 */
export interface AppLogRecord {
  readonly source: AppLogSource;
  readonly level: AppLogEntry['level'];
  readonly text: string;
  readonly at: string;
  readonly step?: number;
}
/** Characters of an event's detail the report admits. */
export const MAX_EVENT_DETAIL_CHARS = 300;

/** Characters of a step label an error message quotes before clipping it. */
const MAX_QUOTED_LABEL_CHARS = 80;

function quoted(label: string): string {
  return `"${label.length > MAX_QUOTED_LABEL_CHARS ? `${label.slice(0, MAX_QUOTED_LABEL_CHARS - 3)}...` : label}"`;
}

/** A step as an error message names it: its api, and its quoted label when it has one. */
function callName(step: { readonly api: string; readonly label: string }): string {
  return step.label === '' ? step.api : `${step.api} ${quoted(step.label)}`;
}

/** Per-call options for `StepRecorder.group`. */
export interface StepGroupOptions {
  /** Whether a thrown value ends the test without failing it (a skip): the step it passes through then passes. */
  readonly passesThrough?: (thrown: unknown) => boolean;
  /** Cuts the step when it aborts, as the engine cuts the calls inside it, beside what cuts any step. */
  readonly signal?: AbortSignal;
}

/** What the recorder keeps about one step while its body runs; dropped whole when the body ends. */
interface ActiveStep {
  readonly record: StepRecord;
  /** The `test.step` the step runs inside. */
  readonly group: ActiveGroup | undefined;
  /** The `owner` that started the step, as `abandonRunning` names it. */
  readonly owner: string;
  /** The stack the step was started from, for the error it fails with when abandoned or named. */
  readonly stack?: string;
  /** The promise the step returned to its caller, observed when the caller did not. */
  pending?: Promise<unknown>;
  /** Set once the code that started the step returned without awaiting it: recorded as failed already, whatever it does next. */
  abandoned?: true;
  /** What the step fails with in place of the abort reason `nameRunning` named it for. */
  named?: { readonly reason: Error; readonly error: Error };
  /** The last screen the step saw, read only when it ends. */
  seenScreen?: () => ScreenText | undefined;
}

/** A running `test.step`. */
interface ActiveGroup extends ActiveStep {
  /** What the steps that failed inside it threw on. Each is that step's error, which this one does not record again. */
  readonly rethrown: Set<unknown>;
  /** The calls still running directly inside it, a `launch()` session's included. */
  readonly inside: Set<Promise<unknown>>;
}

export class StepRecorder {
  private readonly attempt: { readonly id: string; readonly index: number };
  private readonly steps: StepRecord[] = [];
  private readonly scope = new AsyncLocalStorage<StepRecord>();
  /** The `test.step` this code runs inside, with the ones around it. Apart from `scope`: a step called in a `test.step` is still a top-level step, held and verified as one. */
  private readonly groups = new AsyncLocalStorage<ActiveGroup>();
  /** The hook steps run in from now on; undefined while the test body runs. */
  phase: StepPhase | undefined = undefined;
  /**
   * The code that starts steps from now on, as the error for one it leaves
   * running names it: it completes "... returned before", as in
   * `the beforeEach hook`.
   */
  owner = 'the test body';
  /**
   * Whether a top-level step started now waits at `hold`: in `beforeEach` and
   * the body, never in launch or teardown. A pause fails outside these parts
   * of the attempt, and after the body ends.
   */
  holdable = false;
  /** Step calls waiting at their hold, in call order. */
  private readonly held = new Set<HeldCall>();
  /** Pauses waiting at `hold`, ordered by when they were called. */
  private readonly pauses = new Set<HeldPause>();
  /** Steps whose bodies are still executing, by id, in the order they started. */
  private readonly active = new Map<string, ActiveStep>();
  /** The promises of abandoned steps, for the wait before teardown. */
  private readonly abandonedPromises: Promise<unknown>[] = [];
  /** The index every step before which a passed verification proves, or -1 when none has passed. */
  private lastVerified = -1;
  /** What the app logged this attempt, within `APP_LOG_LIMITS`. */
  private readonly logged: AppLogRecord[] = [];
  /** App log entries of each kind `APP_LOG_LIMITS` counts, kept so far. */
  private readonly loggedCounts = { errorsAndWarnings: 0, info: 0 };
  /** The last screen a finished step saw, the one the next step's is compared with. */
  private lastScreen: { readonly step: number; readonly screen: ScreenText } | undefined;
  /** Where the app went before the attempt's first step, told under it once it starts. */
  private readonly earlyNavigations: { line: string; at: string }[] = [];
  private readonly maxEventsPerStep: number;
  private readonly onProgress: StepRecorderOptions['onProgress'];
  private readonly mirror: StepRecorderOptions['mirror'];
  /** The root step sources are read against. */
  readonly projectRoot: string | undefined;
  private readonly redact: ((text: string) => string) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly redactThrown: boolean;
  private readonly retainSteps: number | undefined;
  /** Steps opened so far, the next step's index: `steps` may have dropped its oldest. */
  private opened = 0;
  private readonly hold: RecorderHold | undefined;

  constructor(
    private readonly attemptId: string,
    options: StepRecorderOptions = {},
  ) {
    this.attempt = options.attempt ?? { id: attemptId, index: 0 };
    this.maxEventsPerStep = options.maxEventsPerStep ?? 1_000;
    this.onProgress = options.onProgress;
    this.mirror = options.mirror;
    this.projectRoot = options.projectRoot;
    this.redact = options.redact;
    this.signal = options.signal;
    this.redactThrown = options.redactThrown === true;
    this.retainSteps = options.retainSteps;
    this.hold = options.hold;
  }

  /** Replaces secret values in text the way every record is redacted; identity without a redactor. */
  redactText(text: string): string {
    return this.redact?.(text) ?? text;
  }

  /** Whether a step is still executing. */
  get busy(): boolean {
    return this.active.size > 0;
  }

  /** The step currently executing, when inside StepRecorder.run. */
  get currentStepId(): string | undefined {
    return this.current()?.id;
  }

  /** Timeline index of the currently executing step. */
  get currentStepIndex(): number | undefined {
    return this.current()?.index;
  }

  /** The index every step before which a passed verification proves, or -1 when none has passed. */
  get lastVerifiedStepIndex(): number {
    return this.lastVerified;
  }

  /** Runs one public API call as a recorded top-level step. */
  run<T>(
    kind: StepKind,
    api: string,
    rawLabel: string,
    body: () => Promise<T>,
    options: StepRunOptions = {},
  ): Promise<T> {
    const refused = this.refuseInAbortedRead();
    if (refused !== undefined) return refused;
    // The label is published, reported, and traced as is: a secret the test
    // spelled into an instruction or a locator stops here, once.
    const label = this.redact?.(rawLabel) ?? rawLabel;
    const parent = this.current();
    const group = this.enclosingGroup();
    const stack = stepStack(this.projectRoot);
    // A step inside another (an `onAction` hook's) or inside an `expect.poll`
    // read or a `toPass` block is part of what holds it, so only a top-level step waits.
    if (this.hold?.steps === true && this.holdable && parent === undefined && !insidePollRead()) {
      return this.runHeld(this.hold.ask, { group, kind, api, label, stack, options, cancel: new AbortController(), promise: Promise.resolve() }, body);
    }
    return this.start(kind, api, label, stack, body, options, parent, group);
  }

  /**
   * Runs `body` as one step the test names (`test.step`). The steps `body`
   * starts are recorded as they would be outside it, each with this step as
   * its `parent`, so the group itself is never held and verifies nothing.
   * It fails with what `body` throws, keeping the error only when no step
   * inside it already did.
   */
  group<T>(rawTitle: string, body: () => T | Promise<T>, options: StepGroupOptions = {}): Promise<T> {
    const refused = this.refuseInAbortedRead();
    if (refused !== undefined) return refused;
    const opened = this.open('step', TEST_STEP_API, this.redactText(rawTitle), stepStack(this.projectRoot), {}, this.enclosingGroup());
    const step: ActiveGroup = Object.assign(opened, { rethrown: new Set<unknown>(), inside: new Set<Promise<unknown>>() });
    const promise = this.executeGroup(step, body, options);
    step.pending = promise;
    this.runsInside(step.group, promise);
    return promise;
  }

  /**
   * The rejection of a step called in an `expect.poll` read or a `toPass`
   * block that already ended, or nothing when the step may start. A hook or
   * test may set a provider key after the session opened, so a step that
   * starts takes them in before its label is redacted.
   */
  private refuseInAbortedRead(): Promise<never> | undefined {
    const reading = pollReadSignal();
    if (reading?.aborted === true) {
      const error = abortError(reading, cancelledError);
      markAbandonedRejection(error);
      return Promise.reject(error);
    }
    registerProviderKeys(process.env);
    return undefined;
  }

  private async executeGroup<T>(step: ActiveGroup, body: () => T | Promise<T>, options: StepGroupOptions): Promise<T> {
    const { record } = step;
    const startedMs = Date.now();
    const reading = pollReadSignal();
    const cut = this.cutAfterCallsInside(step, this.cutSignal(reading, options.signal));
    try {
      const work = this.groups.run(step, async () => body());
      // A body waiting on something that is no step would never end it.
      return await (cut === undefined ? work : withAbort(work, cut.signal, () => cut.signal.reason));
    } catch (thrown) {
      // The body may have set a provider key since the step started, and quote it in what it threw.
      registerProviderKeys(process.env);
      if (step.abandoned || reading?.aborted === true) markAbandonedRejection(thrown);
      if (step.abandoned) throw thrown;
      if (options.passesThrough?.(thrown) !== true) {
        const error = classifyError(thrown);
        record.status = failedStatus(error, thrown);
        if (!step.rethrown.has(thrown)) record.error = serializeError(error, { projectRoot: this.projectRoot, redact: this.redact });
      }
      step.group?.rethrown.add(thrown);
      throw thrown;
    } finally {
      cut?.release();
      this.active.delete(record.id);
      if (!step.abandoned) {
        record.durationMs = Date.now() - startedMs;
        this.publishEnd(record);
      }
    }
  }

  /**
   * A signal that aborts with the step's own cancellation once `signal` has
   * and the calls running inside `group` have ended. Their engine calls are
   * cut by the same abort, and each keeps its own outcome: a `test.step` that
   * ended first would leave them running past the body, to be recorded as
   * not awaited. A step that waited for such a call does not record the
   * cancellation again.
   */
  private cutAfterCallsInside(group: ActiveGroup, signal: AbortSignal | undefined): { readonly signal: AbortSignal; release(): void } | undefined {
    if (signal === undefined) return undefined;
    const after = new AbortController();
    const cut = async (): Promise<void> => {
      const cancelled = new TestError('CANCELLED', `${group.record.api} cancelled`);
      if (group.inside.size > 0) group.rethrown.add(cancelled);
      // A body may answer a cut call by starting another.
      while (group.inside.size > 0) await Promise.allSettled(group.inside);
      after.abort(cancelled);
    };
    if (signal.aborted) void cut();
    else signal.addEventListener('abort', cut, { once: true });
    return { signal: after.signal, release: () => signal.removeEventListener('abort', cut) };
  }

  /** Keeps `call` among what runs inside `group` until it settles. */
  private runsInside(group: ActiveGroup | undefined, call: Promise<unknown>): void {
    if (group === undefined) return;
    group.inside.add(call);
    const ended = (): void => void group.inside.delete(call);
    call.then(ended, ended);
  }

  /**
   * Pauses the attempt at `screen.pause()` until `hold.ask` resolves. Without
   * `hold`, as in a program or an MCP session, it returns right away.
   *
   * With `hold`, the call fails outside a holdable part of the attempt or
   * inside another step or an `expect.poll` read or a `toPass` block. The timers there keep
   * running during a pause.
   *
   * The pause and any error that ends it are reported at the test line that
   * called it, even if the runner sent the error from another process.
   */
  async pause(): Promise<void> {
    if (this.hold === undefined) {
      return;
    }

    const request: StepHoldRequest = { kind: 'pause', number: 0, api: 'screen.pause', label: '' };
    const stack = stepStack(this.projectRoot);
    const source = sourceLocation(stack, this.projectRoot);
    const pause: HeldPause = { api: request.api, owner: this.owner, stack, cancel: new AbortController(), promise: Promise.resolve() };

    try {
      // Teardown's separate timer would count time spent paused.
      // Code the test didn't await would pause a test that has ended.
      if (!this.holdable) {
        throw new TestError(
          'INVALID_ARGUMENT',
          withHint(
            `${request.api}() was called after the test body ended (in an afterEach hook, a fixture teardown, or code the test did not await)`,
            'call it in fixture setup, a beforeEach hook, or the test body, and await it',
          ),
        );
      }

      // Another step or an `expect.poll` read or a `toPass` block has a separate timer that
      // counts the pause.
      if (this.current() !== undefined || insidePollRead()) {
        throw new TestError(
          'INVALID_ARGUMENT',
          withHint(
            `${request.api}() was called inside another step (an onAction hook or a project tool), an expect.poll read, or a toPass block`,
            'call it between steps in fixture setup, a beforeEach hook, or the test body',
          ),
        );
      }

      this.pauses.add(pause);
      pause.promise = this.hold.ask(source === undefined ? request : { ...request, source }, pause.cancel.signal);
      await pause.promise;
    } catch (cause) {
      if (cause instanceof Error) {
        relocateStack(cause, stack);
      }

      // Only `abandonRunning` cancels a pause and records its failure.
      if (pause.cancel.signal.aborted) {
        markAbandonedRejection(cause);
      }

      throw cause;
    } finally {
      this.pauses.delete(pause);
    }
  }

  /**
   * Waits at the hold, then starts the step as if it were called now: its
   * index, start, and verification boundary are those of its release, so
   * steps called together in one `Promise.all` keep their call order.
   * The prompt uses the position the step would get if the pending holds
   * started in order with no other steps recorded between them.
   */
  private runHeld<T>(ask: RecorderHold['ask'], call: HeldCall, body: () => Promise<T>): Promise<T> {
    const source = sourceLocation(call.stack, this.projectRoot);
    this.held.add(call);
    const number = this.steps.length + this.held.size;
    const promise = (async () => {
      try {
        await ask({ kind: 'step', number, api: call.api, label: call.label, ...(source === undefined ? {} : { source }) }, call.cancel.signal);
        // Released in the same turn the body abandoned it: it must not run.
        call.cancel.signal.throwIfAborted();
      } catch (cause) {
        // Only `abandonRunning` cancels a call: its failure is recorded, so
        // whatever wrapped the call must not reach the worker as a stray.
        if (call.cancel.signal.aborted) markAbandonedRejection(cause);
        throw cause;
      } finally {
        this.held.delete(call);
      }
      return this.start(call.kind, call.api, call.label, call.stack, body, call.options, undefined, call.group);
    })();
    call.promise = promise;
    return promise;
  }

  /** Records the step as started now and runs its body; `parent` is the step it runs inside, if any, and `group` the `test.step`. */
  private start<T>(
    kind: StepKind,
    api: string,
    label: string,
    stack: string | undefined,
    body: () => Promise<T>,
    options: StepRunOptions,
    parent: StepRecord | undefined,
    group: ActiveGroup | undefined,
  ): Promise<T> {
    // A verification run inside another step (an `onAction` hook's) proves
    // only what the steps before that one left, never the step still running.
    const verifiesBefore = parent?.index ?? this.opened;
    const step = this.open(kind, api, label, stack, options, group);
    const promise = this.execute(step, body, options, verifiesBefore);
    step.pending = promise;
    this.runsInside(group, promise);
    return promise;
  }

  /** Mints a step's record at the next index, started now in the running phase. */
  private file(step: Pick<StepRecord, 'kind' | 'api' | 'label'> & { readonly [Key in 'source' | 'agent' | 'actor' | 'parent']?: StepRecord[Key] | undefined }): StepRecord {
    const index = this.opened;
    this.opened += 1;
    const record: StepRecord = {
      id: `${this.attemptId}:${index}`,
      index,
      kind: step.kind,
      api: step.api,
      label: step.label,
      ...(step.actor === undefined ? {} : { actor: step.actor }),
      ...(step.parent === undefined ? {} : { parent: step.parent }),
      ...(step.source === undefined ? {} : { source: step.source }),
      status: 'passed',
      startedAt: timestamp(),
      durationMs: 0,
      events: [],
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(this.phase === undefined ? {} : { phase: this.phase }),
      artifacts: [],
    };
    this.steps.push(record);
    return record;
  }

  /** Records a step as started now and tells reporters. */
  private open(kind: StepKind, api: string, label: string, stack: string | undefined, options: StepRunOptions, group: ActiveGroup | undefined): ActiveStep {
    const record = this.file({ kind, api, label, source: sourceLocation(stack, this.projectRoot), agent: options.agent, parent: group?.record.index });
    const step: ActiveStep = { record, group, owner: this.owner, ...(stack === undefined ? {} : { stack }) };
    this.active.set(record.id, step);
    // Only a finished step is dropped, and only from the front, so a running
    // one keeps its record, the one opened here included: with nothing
    // retained it is still there for `abandonRunning` to fail.
    while (this.retainSteps !== undefined && this.steps.length > this.retainSteps && !this.active.has(this.steps[0]!.id)) this.steps.shift();
    for (const { line, at } of this.earlyNavigations.splice(0)) this.fileNavigation(record, line, at);
    this.publishStart(record);
    return step;
  }

  /** What cuts a running step: the attempt's signal, and that of the `expect.poll` read or `toPass` block it runs in. */
  private cutSignal(reading: AbortSignal | undefined, also?: AbortSignal): AbortSignal | undefined {
    const signals = [reading, this.signal, also].filter((signal) => signal !== undefined);
    return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  }

  private async execute<T>(step: ActiveStep, body: () => Promise<T>, options: StepRunOptions, verifiesBefore: number): Promise<T> {
    const { record } = step;
    const startedMs = Date.now();
    const reading = pollReadSignal();
    const signal = this.cutSignal(reading);
    try {
      // Model calls made inside the body are attributed to this step.
      const work = this.scope.run(record, () => withAiTraceStep(record.api, record.label, body));
      const result = await (signal === undefined ? work : withAbort(work, signal, () => new TestError('CANCELLED', `${record.api} cancelled`)));
      if (step.abandoned) return result;
      record.durationMs = Date.now() - startedMs;
      if (options.verifies === true) this.lastVerified = Math.max(this.lastVerified, verifiesBefore);
      return result;
    } catch (thrown) {
      registerProviderKeys(process.env);
      // A step that failed on its own, or that another abort reached first, keeps that failure.
      const name = step.named;
      const cause = name !== undefined && thrown === name.reason ? name.error : thrown;
      const failure = modelFailure(cause, this.redact ?? processSecrets.redact);
      if (step.abandoned) {
        const rejection = failure ?? cause;
        markAbandonedRejection(rejection);
        throw rejection;
      }
      record.durationMs = Date.now() - startedMs;
      const error = classifyError(cause);
      record.status = failedStatus(error, cause);
      record.error = serializeError(error, { projectRoot: this.projectRoot, redact: this.redact });
      const onward = failure ?? (this.redactThrown ? error : cause);
      if (reading?.aborted === true && (error.code === 'CANCELLED' || thrown === reading.reason)) {
        markAbandonedRejection(onward);
      }
      if (failure === undefined && this.redactThrown && this.redact !== undefined) redactErrorInPlace(error, this.redact);
      step.group?.rethrown.add(onward);
      throw onward;
    } finally {
      this.active.delete(record.id);
      // An abandoned step reported its end when the body returned; what it did since is not the test's.
      if (!step.abandoned) {
        this.settleScreen(record, step.seenScreen);
        this.publishEnd(record);
      }
    }
  }

  /**
   * Fails every step still running once the code that started it has
   * settled (the test body, a hook, a fixture), and returns the error that
   * names them, or nothing when every step was awaited. The error says
   * which code left the step running: the `owner` it was started under.
   * Each such step is recorded as failed at the line it was called on, its
   * later outcome is dropped, and its rejection is observed here: a step its
   * code abandoned must not take the worker down as an unhandled rejection.
   * Waiting pauses are cancelled the same way.
   */
  abandonRunning(): TestError | undefined {
    // A step still held never ran: it is recorded here, at its call, so it
    // fails like one the body left running, and its hold is let go.
    const held = [...this.held].map((call) => {
      this.held.delete(call);
      call.cancel.abort();
      const step = this.open(call.kind, call.api, call.label, call.stack, call.options, call.group);
      step.pending = call.promise;
      return step;
    });
    // A pause doesn't record a step, so it's cancelled here.
    const pauses = [...this.pauses];
    for (const pause of pauses) {
      this.pauses.delete(pause);
      pause.cancel.abort();
      this.abandonedPromises.push(pause.promise);
    }
    const running = [...this.active.values()].filter((step) => step.abandoned === undefined);
    const count = running.length + pauses.length;
    const [pause] = pauses;
    let first: TestError | undefined;
    if (pause !== undefined) {
      const more = count > 1 ? ` and ${count - 1} more` : '';
      first = new TestError(
        'STEP_NOT_AWAITED',
        withHint(`${pause.owner} returned before ${pause.api}()${more} finished`, 'put `await` in front of screen.pause()'),
      );
      relocateStack(first, pause.stack);
    }
    for (const step of running) {
      const { record } = step;
      const more = first === undefined && count > 1 ? ` and ${count - 1} more` : '';
      const error = new TestError(
        'STEP_NOT_AWAITED',
        withHint(
          `${step.owner} returned before ${callName(record)}${more} finished`,
          record.kind === 'step' ? "put `await` in front of test.step(); a fixture can't call use() inside one" : 'put `await` in front of every step call',
        ),
      );
      relocateStack(error, step.stack);
      first ??= error;
      step.abandoned = true;
      record.status = 'failed';
      record.durationMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
      record.error = serializeError(error, { projectRoot: this.projectRoot, redact: this.redact });
      if (step.pending !== undefined) {
        step.pending.catch(() => undefined);
        this.abandonedPromises.push(step.pending);
      }
      this.publishEnd(record);
    }
    // No body runs for a held step, so nothing else ends what it started.
    for (const { record } of held) this.active.delete(record.id);
    return first;
  }

  /**
   * Names every step still running in the error it fails with once the
   * recorder's signal aborts with `reason`: what `error` builds for the call,
   * at the line that made it. Call it right before that abort. Unlike
   * `abandonRunning`, nothing is recorded as not awaited and no rejection is
   * observed: a program closes a session to cancel what runs on it, and the
   * calls it cut are its own to handle.
   */
  nameRunning(reason: Error, error: (call: string) => Error): void {
    for (const step of this.active.values()) {
      const named = error(callName(step.record));
      relocateStack(named, step.stack);
      step.named = { reason, error: named };
    }
  }

  /** Resolves once every abandoned step has settled, however it did; the caller bounds the wait. */
  async settleAbandoned(): Promise<void> {
    await Promise.allSettled(this.abandonedPromises);
  }

  private publishEnd(record: StepRecord): void {
    this.publish(record, {
      phase: 'end',
      kind: record.kind,
      api: record.api,
      label: record.label,
      status: record.status,
      durationMs: record.durationMs,
      modelCalls: record.events.filter((event) => event.kind === 'model').length,
      ...(record.error === undefined ? {} : { error: record.error }),
      ...(record.explanation === undefined ? {} : { explanation: record.explanation }),
    });
  }

  /**
   * Attaches an artifact ID to the running step, or to the most recent step
   * when none is running. The running step wins so a step that ran a nested
   * step (a fixture call that clicked a link, say) still owns what it produced.
   */
  attachArtifact(artifactId: string): void {
    // Cleanup outside a scope may attach to the last step. Work inherited
    // from a closed scope must never attach to a newer step.
    const target = this.scope.getStore() === undefined ? this.lastOwn() : this.current();
    if (target !== undefined) target.artifacts.push(artifactId);
  }

  /** Records one child event of the running step. */
  recordEvent(event: StepEvent): void {
    const current = this.current();
    if (current === undefined) return;
    this.push(current, event);
  }

  /**
   * Keeps one thing the app did on its own, with the step running in this
   * async context, else the step that started last: an engine reports from
   * its own event callbacks, outside any step's context, so a request that
   * fails after a tap resolved lands with the tap. A log line goes to the
   * attempt's app log (`appLog`), within `APP_LOG_LIMITS`; where the app went
   * is an event of the step, and one before the first step waits for it.
   */
  recordAppEvent(event: AppEvent, at: string = timestamp()): void {
    const target = this.current() ?? this.lastOwn();
    if (event.kind === 'navigation') {
      if (target === undefined) {
        // A step takes no more events than this, so no more wait for one.
        if (this.earlyNavigations.length < this.maxEventsPerStep) this.earlyNavigations.push({ line: event.line, at });
      }
      else this.fileNavigation(target, event.line, at);
      return;
    }
    const { entry } = event;
    const counted = entry.level === 'info' ? 'info' : 'errorsAndWarnings';
    if (this.loggedCounts[counted] >= APP_LOG_LIMITS[counted]) return;
    this.loggedCounts[counted] += 1;
    // Redacted before it is cut, so no cut leaves the head of a secret behind.
    const text = bound(this.redactText(entry.text.replace(/\s+/g, ' ').trim()), MAX_EVENT_DETAIL_CHARS);
    this.logged.push({ source: entry.source, level: entry.level, text, at, ...(target === undefined ? {} : { step: target.index }) });
  }

  /** What the app logged this attempt, oldest first. */
  appLog(): readonly AppLogRecord[] {
    return this.logged;
  }

  /**
   * Notes a screen the running step saw; the newest one stands. `read`
   * renders it, redacted, and runs once, when the step ends, so a step that
   * observes many times pays for one. A screen no step is running for (the
   * failure evidence, a launch) is the trace's only through the screen at failure.
   */
  recordScreen(read: () => ScreenText | undefined): void {
    const step = this.currentStep();
    if (step !== undefined) step.seenScreen = read;
  }

  /** Compares the last screen a step saw with the one before it, once the step has ended. */
  private settleScreen(record: StepRecord, read: (() => ScreenText | undefined) | undefined): void {
    if (read === undefined) return;
    let screen: ScreenText | undefined;
    try {
      screen = read();
    } catch {
      return;
    }
    if (screen === undefined) return;
    record.screen = compareScreens(this.lastScreen, screen);
    this.lastScreen = { step: record.index, screen };
  }

  private fileNavigation(target: StepRecord, line: string, at: string): void {
    this.push(target, { kind: 'navigation', startedAt: at, durationMs: 0, status: 'passed', detail: line.replace(/\s+/g, ' ').trim() });
  }

  /** Appends an event to a step, its prose redacted, within the per-step cap. */
  private push(step: StepRecord, event: StepEvent): void {
    if (step.events.length >= this.maxEventsPerStep) return;
    // Redacted before it is cut, so no cut leaves the head of a secret behind.
    const detail = event.detail === undefined ? undefined : (this.redact?.(event.detail) ?? event.detail);
    const redacted = detail === undefined ? event : { ...event, detail: bound(detail, MAX_EVENT_DETAIL_CHARS) };
    step.events.push(redacted);
    this.publish(step, { phase: 'event', api: step.api, event: redacted });
  }

  /**
   * Tells reporters the trace cache has the running step (`true`), or has
   * handed it to the model (`false`). Nothing is recorded: the step's `cache`
   * detail says how the replay went. Outside a running step this is a no-op,
   * as `recordEvent` is.
   */
  replaying(active: boolean): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'replay', api: current.api, active });
  }

  /**
   * Tells reporters what the running step waits on now; the phase's `event`
   * later reports how it went. Nothing is recorded. Outside a running step
   * this is a no-op, as `recordEvent` is.
   */
  activity(activity: StepActivity): void {
    const current = this.current();
    if (current === undefined) return;
    this.publish(current, { phase: 'activity', api: current.api, activity });
  }

  /** Merges agent metrics, provenance, and judgment detail into the running step. */
  attachAgentDetails(details: StepAgentDetails): void {
    const current = this.current();
    if (current === undefined) return;
    if (details.metrics !== undefined) current.metrics = details.metrics;
    // A key given as a model id or an agent's model label is redacted like any other text the report holds.
    if (details.model !== undefined) current.model = { ...details.model, provider: processSecrets.redact(details.model.provider), model: processSecrets.redact(details.model.model) };
    if (details.cache !== undefined) current.cache = this.cacheForReport(details.cache);
    if (details.observationRevision !== undefined) {
      current.observationRevision = details.observationRevision;
    }
    if (details.observationTruncated !== undefined) {
      current.observationTruncated = details.observationTruncated;
    }
    if (details.explanation !== undefined) {
      current.explanation = this.redact?.(details.explanation) ?? details.explanation;
    }
    if (details.visionInput !== undefined) current.visionInput = details.visionInput;
    if (details.visionDegraded !== undefined) current.visionDegraded = details.visionDegraded;
    if (details.visionOnly !== undefined) current.visionOnly = details.visionOnly;
    if (details.turns !== undefined) current.turns = details.turns;
  }

  /** Records the viewport a step established. */
  attachViewport(viewport: { width: number; height: number; scale: number }): void {
    const current = this.current();
    if (current !== undefined) current.viewport = viewport;
  }

  all(): readonly StepRecord[] {
    return this.steps;
  }

  /** Steps of the test's own session whose execution has finished, e.g. as prior-step prompt context. */
  completed(): readonly StepRecord[] {
    return this.steps.filter((step) => isOwnStep(step) && !this.active.has(step.id));
  }

  /**
   * Files a step another session runs (`run/guest-steps.ts`) and tells
   * reporters it started. The step takes the next index, so the report tells
   * both sessions' steps in the order they began. It is the other session's
   * in every other way: never the running step here, so it is not held and
   * it verifies nothing.
   */
  guest(step: Pick<StepRecord, 'kind' | 'api' | 'label' | 'actor'> & { readonly source: SourceLocation | undefined }): GuestRecord {
    const group = this.enclosingGroup();
    const record = this.file({ ...step, label: this.redactText(step.label), parent: group?.record.index });
    let ended = (): void => undefined;
    this.runsInside(group, new Promise<void>((resolve) => { ended = resolve; }));
    this.publishStart(record);
    return {
      tell: (progress) => {
        if (progress.phase === 'event') this.push(record, progress.event);
        else this.publish(record, progress);
      },
      end: (result) => {
        const { cache, ...fields } = result;
        Object.assign(record, fields);
        if (cache !== undefined) record.cache = this.cacheForReport(cache);
        this.publishEnd(record);
        ended();
      },
    };
  }

  /** The report may know values that an older recording or a guest session did not. */
  private cacheForReport(cache: StepCacheRecord): StepCacheRecord {
    if (cache.recordedBy === undefined) return cache;
    const { recordedBy, ...rest } = cache;
    const redact = this.redact ?? processSecrets.redact;
    const model = readRecordedModel({ provider: redact(recordedBy.provider), model: redact(recordedBy.model) }, MAX_TRACE_DESCRIPTOR_CHARS);
    return model === undefined ? rest : { ...rest, recordedBy: model };
  }

  /** The last call on the test's own session, the one an event with no running step belongs to; a `test.step` is a name over calls, not one. */
  private lastOwn(): StepRecord | undefined {
    return this.steps.findLast((step) => isOwnStep(step) && step.kind !== 'step');
  }

  /** The step whose body this call runs inside, unless it ended or was abandoned. */
  private currentStep(): ActiveStep | undefined {
    const record = this.scope.getStore();
    const step = record === undefined ? undefined : this.active.get(record.id);
    return step?.abandoned === undefined ? step : undefined;
  }

  private current(): StepRecord | undefined {
    return this.currentStep()?.record;
  }

  /** The innermost `test.step` still running that this call is inside; one that ended is no parent to work it left behind. */
  private enclosingGroup(): ActiveGroup | undefined {
    for (let group = this.groups.getStore(); group !== undefined; group = group.group) {
      if (this.active.has(group.record.id) && group.abandoned === undefined) return group;
    }
    return undefined;
  }

  /** Publishes a phase with the owning record's identity, including nested and finishing steps. */
  private publish(record: StepRecord, fact: StepProgressFact): void {
    if (this.onProgress === undefined && this.mirror === undefined) return;
    const progress: StepProgress = {
      ...fact,
      identity: {
        attemptId: this.attempt.id,
        attemptIndex: this.attempt.index,
        stepId: record.id,
        stepIndex: record.index,
        ...(record.actor === undefined ? {} : { actor: record.actor }),
        ...(record.parent === undefined ? {} : { parentStepId: `${this.attemptId}:${record.parent}` }),
      },
    };
    this.onProgress?.(progress);
    this.mirror?.(progress, record);
  }

  /** Tells that `record`'s step began, from where the test called it. */
  private publishStart(record: StepRecord): void {
    const { kind, api, label, source } = record;
    this.publish(record, { phase: 'start', kind, api, label, ...(source === undefined ? {} : { source }) });
  }
}
