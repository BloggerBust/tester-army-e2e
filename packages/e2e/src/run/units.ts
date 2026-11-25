/**
 * Work-unit planning and the records for work the
 * scheduler reports without dispatching it. Every `ResultRecord` built from a
 * pair goes through `pairResult`, which narrows the pair's collected test to
 * its serializable identity.
 */

import path from 'node:path';
import type { Collection } from '../collect/collect.ts';
import { testIdentity } from '../collect/collect.ts';
import type { Selection, TestTargetPair } from '../collect/select.ts';
import type { SkipInfo } from '@e2e-dev/core/lib/run/records';
import type { ResolvedTarget } from '@e2e-dev/core/lib/config/resolve';
import type { SerializedError } from '@e2e-dev/core/lib/internal/errors';
import type { AttemptRecord, ResultRecord, ResultStatus } from '@e2e-dev/core/lib/run/records';
import type { WirePair } from './worker/protocol.ts';

/**
 * One schedulable unit: either a single setup pair, or runnable ordinary
 * pairs of one file for one target that run in order on one worker. That is
 * every such pair of the file, unless some are in a parallel scope; see
 * `splitFile`. Units execute on exactly one worker.
 */
export interface WorkUnit {
  readonly id: string;
  readonly kind: 'setup' | 'file';
  readonly targetName: string;
  /** Normalized project-root-relative file path. */
  readonly file: string;
  readonly absolutePath: string;
  /** Pairs with disposition `run`, in declaration order. */
  readonly pairs: readonly TestTargetPair[];
  /** The part of its file's runnable pairs a file unit holds, from above 0 through 1; 1 for a setup unit. */
  readonly share: number;
  /** Whether the unit is one of several its file was cut into: a worker keeps its import of the file for the next of them, and holds none for a file with one unit. */
  readonly split: boolean;
}

/** Per-target schedule: setup units gate file units. */
export interface TargetWorkPlan {
  readonly target: ResolvedTarget;
  readonly setupUnits: readonly WorkUnit[];
  readonly fileUnits: readonly WorkUnit[];
  /** Non-run ordinary pairs the scheduler reports without dispatching. */
  readonly immediate: readonly TestTargetPair[];
  /** Worker cap the engine reported from `prepare`, over its declared `workers`. */
  readonly workers?: number;
  /** Variables the engine's `prepare` handed this target's workers; see `EnginePrepareResult.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Builds per-target work plans from a selection, preserving report order.
 * `workers` is the run's worker cap, which decides how many units the tests
 * with suite hooks of a parallel scope share; see `splitFile`. `inMemoryFile`
 * names the file of tests registered in memory, which stays one unit: there
 * is no module to import again for a second.
 */
export function buildWorkPlans(
  selection: Selection,
  collection: Collection,
  projectRoot: string,
  workers: number,
  inMemoryFile?: string,
): TargetWorkPlan[] {
  return selection.perTarget.map(({ target, pairs }) => {
    const parallelism = targetWorkers(target, workers);
    // One pass sorts every pair into its bucket; files are then visited in
    // collection order so unit order (and thus report order) is stable.
    const setupUnits: WorkUnit[] = [];
    const runnableByFile = new Map<string, TestTargetPair[]>();
    const immediate: TestTargetPair[] = [];
    for (const pair of pairs) {
      if (pair.test.kind === 'setup') {
        if (pair.disposition !== 'run') continue;
        setupUnits.push({
          id: `setup::${target.name}::${pair.test.id}`,
          kind: 'setup',
          targetName: target.name,
          file: pair.test.file,
          absolutePath: path.resolve(projectRoot, pair.test.file),
          pairs: [pair],
          share: 1,
          split: false,
        });
      } else if (pair.disposition !== 'run') {
        immediate.push(pair);
      } else {
        const bucket = runnableByFile.get(pair.test.file);
        if (bucket === undefined) runnableByFile.set(pair.test.file, [pair]);
        else bucket.push(pair);
      }
    }

    const fileUnits: WorkUnit[] = [];
    for (const file of collection.files) {
      const filePairs = runnableByFile.get(file.file);
      if (filePairs === undefined) continue;
      // Not spread into `push`: a file can be cut into more units than a call takes arguments.
      for (const unit of unitsOfFile(target, file, filePairs, parallelism, file.file === inMemoryFile)) fileUnits.push(unit);
    }

    return { target, setupUnits, fileUnits, immediate };
  });
}

/** The units that run one file's runnable pairs on a target that runs `parallelism` workers; see `splitFile`. */
function unitsOfFile(
  target: ResolvedTarget,
  file: Pick<WorkUnit, 'file' | 'absolutePath'>,
  pairs: readonly TestTargetPair[],
  parallelism: number,
  whole = false,
): WorkUnit[] {
  const ordered = pairs.toSorted((a, b) => a.test.declarationIndex - b.test.declarationIndex);
  const id = `file::${target.name}::${file.file}`;
  const cut = whole ? [ordered] : splitFile(ordered, target.fullyParallel, parallelism);
  return cut.map((unitPairs, index) => ({
    // A file that is one unit keeps the id it always had.
    id: index === 0 ? id : `${id}::${index}`,
    kind: 'file',
    targetName: target.name,
    file: file.file,
    absolutePath: file.absolutePath,
    pairs: unitPairs,
    share: unitPairs.length / ordered.length,
    split: cut.length > 1,
  }));
}

/**
 * The plan for a target whose engine's `prepare` reported `workers`, fewer
 * than the plan was cut for: each file is cut again for that many, so its
 * tests do not run its suite hooks more often than the workers there are
 * can use. The caller orders the plan again.
 */
export function withWorkerCap(plan: TargetWorkPlan, workers: number): TargetWorkPlan {
  const byFile = new Map<string, WorkUnit[]>();
  for (const unit of plan.fileUnits) {
    const units = byFile.get(unit.file);
    if (units === undefined) byFile.set(unit.file, [unit]);
    else units.push(unit);
  }
  const fileUnits = [...byFile.values()].flatMap((units) =>
    units.length === 1 ? units : unitsOfFile(plan.target, units[0]!, units.flatMap((unit) => unit.pairs), workers),
  );
  return { ...plan, workers, fileUnits };
}

/**
 * Cuts one file's runnable pairs, in declaration order, into the units that
 * run them, each unit's pairs in order on one worker. A pair in no parallel
 * scope (a group or file with `parallel: true`, or every file under
 * `fullyParallel`) stays in the file's one ordered unit, the first. In a
 * parallel scope:
 *
 * - a serial group, or a scope with `parallel: false`, is one unit for each
 *   agent it runs as;
 * - a test with no `beforeAll` or `afterAll` around it is a unit of its own
 *   for each agent;
 * - the tests with such hooks share as few units as keep `parallelism`
 *   workers busy, since each unit runs the hooks again; an agent's tests
 *   never share a unit with another's.
 *
 * A unit holds every repeat of its tests, in order: the first repeat records
 * the replay cache and the rest replay it, which repeats that ran at the
 * same time could not.
 *
 * The cut is the same whatever `parallelism` is, but for how many units the
 * tests with hooks share: a test that runs apart from another does so on
 * one worker too. Units of a file that one worker runs share its import of
 * the file (`RealmManager.keep`), so they share the file's state there.
 */
function splitFile(pairs: readonly TestTargetPair[], fullyParallel: boolean, parallelism: number): TestTargetPair[][] {
  const inOrder: TestTargetPair[] = [];
  const scopes = new Map<string, TestTargetPair[]>();
  const alone = new Map<string, TestTargetPair[]>();
  const hooked = new Map<string, Map<string, TestTargetPair[]>>();
  for (const pair of pairs) {
    const { declared, ordered, suiteHooks } = pair.test.parallel;
    if (!(declared || fullyParallel) || ordered === 'file') inOrder.push(pair);
    else if (ordered !== undefined) gather(scopes, agentKey(ordered, pair.agent), pair);
    else if (suiteHooks) {
      let tests = hooked.get(pair.agent);
      if (tests === undefined) hooked.set(pair.agent, (tests = new Map()));
      gather(tests, pair.test.id, pair);
    } else gather(alone, agentKey(pair.test.id, pair.agent), pair);
  }
  const sharing: TestTargetPair[][] = [];
  for (const tests of hooked.values()) {
    for (const batch of evenBatches([...tests.values()], parallelism)) sharing.push(batch.flat());
  }
  const split = [...scopes.values(), ...alone.values(), ...sharing].toSorted((a, b) => a[0]!.test.declarationIndex - b[0]!.test.declarationIndex);
  return inOrder.length === 0 ? split : [inOrder, ...split];
}

/** The key of what one agent runs of `id`, a test or a scope. */
function agentKey(id: string, agent: string): string {
  return `${id}\u0000${agent}`;
}

/** Adds `pair` to the pairs `groups` holds under `key`. */
function gather(groups: Map<string, TestTargetPair[]>, key: string, pair: TestTargetPair): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [pair]);
  else group.push(pair);
}

/** `items` in order, cut into `count` runs (fewer when there are fewer items) whose lengths differ by one at most. */
function evenBatches<Item>(items: readonly Item[], count: number): Item[][] {
  const batches: Item[][] = [];
  const total = Math.min(items.length, Math.max(1, count));
  let start = 0;
  for (let index = 0; index < total; index += 1) {
    const size = Math.ceil((items.length - start) / (total - index));
    batches.push(items.slice(start, start + size));
    start += size;
  }
  return batches;
}

/** What `orderWorkPlans` ranks the work by. */
export interface WorkOrder {
  /** How likely the test filters rated a test to fail on this change, from 0 to 1; 0 for a test none scored. */
  readonly relevanceOf: (testId: string) => number;
  /** How long the previous run spent in a target's file; `undefined` when it has no timing, as every file does when the run reads none. */
  readonly durationOf: (targetName: string, file: string) => number | undefined;
}

/** The scores at which a test enters the next higher relevance band, so a score of at least 0.75 is band 3, and under 0.25 band 0. */
const RELEVANCE_EDGES: readonly number[] = [0.25, 0.5, 0.75];

/** The relevance band of a score: how many of `RELEVANCE_EDGES` it reaches. */
export function relevanceBand(score: number): number {
  return RELEVANCE_EDGES.filter((edge) => score >= edge).length;
}

/**
 * Orders each plan's file units, and the plans, so the work likeliest to fail
 * starts first and long units start early. A unit ranks by the highest
 * relevance band of the tests it runs, and within a band longest first by
 * the time the previous run spent in its file, counted by the unit's share
 * of the file's pairs, so a long unit starts while short ones fill the other
 * workers instead of starting last and running alone. Units of a file
 * without a timing go first, being of unknown length; ties keep collection
 * order. A target ranks by its best unit, ties keeping config order. Report
 * order does not depend on dispatch order.
 */
export function orderWorkPlans(plans: readonly TargetWorkPlan[], { relevanceOf, durationOf }: WorkOrder): TargetWorkPlan[] {
  const ranked = plans.map((plan) => {
    const units = plan.fileUnits
      .map((unit) => ({
        unit,
        band: unit.pairs.reduce((best, pair) => Math.max(best, relevanceBand(relevanceOf(pair.test.id))), 0),
        duration: (durationOf(unit.targetName, unit.file) ?? Number.POSITIVE_INFINITY) * unit.share,
      }))
      .toSorted((a, b) => {
        const longer = b.duration - a.duration;
        return b.band - a.band || (Number.isNaN(longer) ? 0 : longer);
      });
    return { plan: { ...plan, fileUnits: units.map(({ unit }) => unit) }, band: units[0]?.band ?? 0 };
  });
  return ranked.toSorted((a, b) => b.band - a.band).map(({ plan }) => plan);
}

/**
 * The worker slots the run will start for a plan, `0` to `slots - 1`: the
 * run's worker cap, the engine's declared `workers`, and the units to
 * dispatch, whichever is smallest. A strict bound: a worker retired after a
 * failing unit holds its slot until it exits, so its replacement may take a
 * higher one, but never more slots than there are units to fail on.
 */
export function plannedSlots(plan: TargetWorkPlan, runWorkers: number): number {
  const units = plan.setupUnits.length + plan.fileUnits.length;
  return Math.min(targetWorkers(plan.target, runWorkers), units);
}

/** The workers a target can have at once: the run's worker cap, or the fewer its engine declares. */
function targetWorkers(target: ResolvedTarget, runWorkers: number): number {
  return Math.min(runWorkers, target.engine?.workers ?? runWorkers);
}

/** Skip info for a pair whose session-producing setup did not pass. */
export function setupFailedSkip(session: string, setupTestId: string): SkipInfo {
  return {
    cause: 'setup-failed',
    reason: `setup for session "${session}" failed`,
    relatedId: setupTestId,
  };
}

/** Skip info for runnable work an interrupt cancelled before it started. */
export const INTERRUPTED_BEFORE_START: SkipInfo = {
  cause: 'infrastructure-unavailable',
  reason: 'run interrupted before execution',
};

/** Whether a result counts toward `--max-failures`: a failed or timed-out one. */
export function countsTowardFailureLimit(status: ResultRecord['status']): boolean {
  return status === 'failed' || status === 'timed-out';
}

/** Skip info for the work a run stopped at its failure limit never started. */
export function failureLimitSkip(failures: number, limit: number): SkipInfo {
  return {
    cause: 'failure-limit',
    reason: `run stopped after ${failures} ${failures === 1 ? 'failure' : 'failures'} (--max-failures ${limit})`,
  };
}

/** A run's time limit, in milliseconds, and where it was set: the `--max-duration` flag or the config's `maxDuration`. */
export interface TimeLimit {
  readonly ms: number;
  readonly source: '--max-duration' | 'maxDuration';
}

/** Skip info for the work a run stopped at its time limit never started. */
export function timeLimitSkip(limit: TimeLimit): SkipInfo {
  return {
    cause: 'time-limit',
    reason: `run stopped at its time limit of ${limit.ms} ms (${limit.source})`,
  };
}

/**
 * The skip for work an interrupt reached before it started: the skip the
 * interrupt carried as its reason (a run stopped at its failure limit says
 * so), else the plain interrupt.
 */
export function interruptedSkip(signal: AbortSignal, fallback: SkipInfo = INTERRUPTED_BEFORE_START): SkipInfo {
  const reason: unknown = signal.reason;
  return isSkipInfo(reason) ? reason : fallback;
}

/**
 * The message of an attempt an interrupt cut short in `phase`, naming the
 * limit that stopped the run when the interrupt carried one.
 */
export function interruptedInPhase(signal: AbortSignal, phase: string): string {
  const reason: unknown = signal.reason;
  const message = `run interrupted in phase ${phase}`;
  return isSkipInfo(reason) ? `${message}: ${reason.reason}` : message;
}

function isSkipInfo(value: unknown): value is SkipInfo {
  return typeof value === 'object' && value !== null && typeof (value as SkipInfo).cause === 'string' && typeof (value as SkipInfo).reason === 'string';
}

/**
 * Builds a result for one pair, narrowing the collected test to its identity
 * so no test function or realm state can reach a record or the wire.
 */
export function pairResult(
  pair: TestTargetPair,
  fields: Omit<ResultRecord, 'test' | 'target' | 'agent' | 'repeat'>,
): ResultRecord {
  return { test: testIdentity(pair.test), target: pair.target, agent: pair.agent, repeat: pair.repeat, ...fields };
}

/**
 * The result of a test or setup unit that ran. A beforeAll failure before
 * any attempt ran skips the unit; on a retry the recorded attempts stand,
 * since the hook failure is already a run error and a failing test must not
 * be reported as skipped. A unit whose body skipped itself ends on its first
 * skipped attempt (`runWithRetries`), so that attempt's reason is the
 * result's.
 */
export function unitResult(
  pair: TestTargetPair,
  finalStatus: ResultStatus,
  attempts: AttemptRecord[],
  hookFailure: Pick<SerializedError, 'message'> | undefined,
): ResultRecord {
  if (hookFailure !== undefined && attempts.length === 0) {
    return pairResult(pair, { status: 'skipped', selected: true, skip: { cause: 'hook-failed', reason: hookFailure.message }, attempts: [] });
  }
  const last = attempts.at(-1);
  return pairResult(pair, { status: finalStatus, selected: true, attempts, ...(last?.status === 'skipped' ? { skip: last.skip } : {}) });
}

/** The identity of one pair among a unit's: a test runs once per agent it is pinned to, and once per repeat. */
export function pairKey(testId: string, agent: string, repeat: number): string {
  return `${testId}\u0000${agent}\u0000${repeat}`;
}

/** Result for a pair reported skipped or unselected without ever dispatching. */
export function nonRunResult(pair: TestTargetPair): ResultRecord {
  if (pair.disposition === 'skip') {
    return pairResult(pair, { status: 'skipped', selected: true, skip: pair.skip, attempts: [] });
  }
  return pairResult(pair, {
    status: 'skipped',
    selected: false,
    skip: pair.skip ?? { cause: 'filtered', reason: 'not selected' },
    attempts: [],
  });
}

/** Result for a runnable pair the run never started. */
export function unstartedResult(pair: TestTargetPair, skip: SkipInfo): ResultRecord {
  return pairResult(pair, {
    status: 'skipped',
    selected: pair.disposition === 'run',
    skip,
    attempts: [],
  });
}

/** Result for a test that vanished between planning and execution. */
export function disappearedResult(pair: WirePair, target: ResolvedTarget): ResultRecord {
  return { test: pair.test, target, agent: pair.agent, repeat: pair.repeat, status: 'failed', selected: true, attempts: [] };
}
