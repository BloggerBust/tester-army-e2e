/**
 * What one result left behind, wherever the report keeps it. A serial
 * member's result carries no attempts of its own: its error, duration, and
 * steps live on the group's attempts, keyed by test id. Every other
 * result answers from its own attempts. The reporters that read a result
 * (JUnit, markdown, CTRF) share this one reading.
 */

import type { SkipInfo } from '@e2e-dev/core/lib/run/records';
import type { FailureEvidence } from '@e2e-dev/core/lib/run/records';
import { memberRan } from '@e2e-dev/core/lib/run/records';
import type { AppLogRecord } from '@e2e-dev/core/lib/run/steps';
import { isCutSerialRetry } from '../run/retry.ts';
import type { ReportError, ReportResult, ReportSerialGroup, ReportStep } from './build.ts';

type ReportArtifact = ReportResult['attempts'][number]['artifacts'][number];
type ReportSerialAttempt = ReportSerialGroup['attempts'][number];

/**
 * An artifact a test owns: one its own records name, or, for a serial member,
 * one the group attempt made that no member's records name, such as the
 * group's video (`shared`).
 */
export interface OwnedArtifact {
  readonly artifact: ReportArtifact;
  readonly shared: boolean;
}

/** One attempt as a reporter reads it: what stopped it, the steps up to there, and what it left behind. */
export interface AttemptView {
  /** The attempt's id; for a serial member, its member record's. Absent when the test never ran here. */
  readonly id: string | undefined;
  /** When the attempt (for a serial member, its own part of it) started; absent when the test never ran here. */
  readonly startedAt: string | undefined;
  /** Whether the test itself ran in this attempt: false for a serial member the group attempt never reached. */
  readonly ran: boolean;
  readonly status: ReportResult['attempts'][number]['status'] | 'skipped';
  /** How long the attempt ran; for a serial member, the member's own part of it. */
  readonly durationMs: number;
  /** This attempt's member records are not the verdict: the retry was interrupted, or it never reached its members. */
  readonly cut: boolean;
  readonly error: ReportError | undefined;
  readonly steps: readonly ReportStep[];
  /** What the app logged during the attempt (for a serial member, during its part of it), each line with its step. */
  readonly appLog: readonly AppLogRecord[];
  /** What the runner saw when the failure landed, when it captured anything. */
  readonly failure: FailureEvidence | undefined;
  /** The attempt's own artifacts; for a serial member, the group attempt's. */
  readonly artifacts: readonly ReportArtifact[];
  /**
   * The artifacts that belong to this test, in the attempt's order: all of a
   * plain attempt's. A serial member gets the ones its own records name (a
   * step's artifact ids, a step as producer, its failure's screenshot and
   * screen) and the group attempt's that no member's records name, marked
   * `shared`; never a sibling's. Empty for a member the attempt never
   * reached. Worked out when read, so a reporter that never reads it pays
   * nothing.
   */
  readonly owned: readonly OwnedArtifact[];
  /** What else failed after the error: a teardown hook, the engine's cleanup. */
  readonly secondaryErrors: readonly ReportError[];
  /** What the engine said the attempt ran on; for a serial member, the group attempt's. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** Why the body skipped itself; on a failed attempt, a skip the failure outranked. */
  readonly skip: SkipInfo | undefined;
}

export interface Outcome {
  /** The verdict attempt's duration. */
  readonly durationMs: number;
  /** The final attempt: the verdict of a failed test, the passing retry of a flaky one. */
  readonly final: AttemptView;
  /** The last attempt that reached the result's verdict, so a retry the run interrupted does not stand for it; otherwise the final one. */
  readonly verdict: AttemptView;
  /** The last attempt that did not pass before the final one, when there was one: what a flaky test hit. */
  readonly lastFailed: AttemptView | undefined;
  /** Every attempt in order, so a reporter can say whether they failed alike. */
  readonly attempts: readonly AttemptView[];
  /** Attempts that did not pass before the final one; what a flaky pass cost. */
  readonly failedAttempts: number;
}

/**
 * Whether a file for CI (JUnit, CTRF) lists the result: the run selected it,
 * or a test filter left it out, which reads as a skip naming the filter.
 * Other unselected results are report-only.
 */
export function listedInCi(result: ReportResult): boolean {
  return result.selected !== false || result.skip?.filter !== undefined;
}

/** What a result that never ran an attempt reads as. */
const NO_ATTEMPT: AttemptView = { id: undefined, startedAt: undefined, ran: false, owned: [], status: 'skipped', durationMs: 0, cut: false, error: undefined, steps: [], appLog: [], failure: undefined, artifacts: [], secondaryErrors: [], skip: undefined };

export function outcome(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): Outcome {
  const views = attemptViews(result, groups);
  const earlier = views.slice(0, -1);
  const final = views.at(-1) ?? NO_ATTEMPT;
  const verdict = views.findLast((view) => !view.cut && reachedVerdict(result.status, view.status)) ?? final;
  return {
    durationMs: verdict.durationMs,
    final,
    verdict,
    lastFailed: earlier.toReversed().find((attempt) => attempt.status !== 'passed'),
    attempts: views,
    failedAttempts: earlier.filter((attempt) => attempt.status !== 'passed').length,
  };
}

/** The result's attempts as views; a serial member's from its group, keyed by test id. */
function attemptViews(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>): AttemptView[] {
  if (result.serialGroupId === undefined) {
    return result.attempts.map((attempt) => ({
      id: attempt.id,
      startedAt: attempt.startedAt,
      ran: true,
      get owned(): readonly OwnedArtifact[] {
        return attempt.artifacts.map((artifact) => ({ artifact, shared: false }));
      },
      status: attempt.status,
      durationMs: attempt.durationMs,
      cut: false,
      error: attempt.error,
      steps: attempt.steps,
      appLog: attempt.appLog ?? [],
      failure: attempt.failure,
      artifacts: attempt.artifacts,
      secondaryErrors: attempt.secondaryErrors,
      environment: attempt.environment,
      skip: attempt.skip,
    }));
  }
  const attempts = groups.get(result.serialGroupId)?.attempts ?? [];
  return attempts.map((attempt, index) => {
    const member = attempt.members.find((candidate) => candidate.testId === result.testId);
    const ran = member !== undefined && memberRan(member);
    return {
      id: member?.id,
      startedAt: member?.startedAt,
      ran,
      // Worked out only when a reporter asks, so one that never reads it pays nothing.
      get owned(): readonly OwnedArtifact[] {
        return ran ? memberArtifacts(attempt, result.testId) : [];
      },
      status: member?.status ?? attempt.status,
      durationMs: member?.durationMs ?? 0,
      // Older reports lack `cutRetry`; infer it from the attempt's status.
      cut: attempt.cutRetry ?? isCutSerialRetry(attempt.status, index, true),
      error: member?.error ?? attempt.error,
      steps: member?.steps ?? [],
      appLog: member?.appLog ?? [],
      failure: member?.failure,
      artifacts: attempt.artifacts,
      // The member's own, then the shared session's: its cleanup errors land on the group attempt.
      secondaryErrors: [...(member?.secondaryErrors ?? []), ...attempt.secondaryErrors],
      environment: attempt.environment,
      skip: member?.skip,
    };
  });
}

/** Which members name each artifact of a group attempt, by artifact id; worked out once per attempt. */
const OWNERS = new WeakMap<ReportSerialAttempt, ReadonlyMap<string, ReadonlySet<string>>>();

/**
 * The test ids whose records name each artifact of a group attempt: a step's
 * artifact ids, a step as the artifact's producer, a failure's screenshot
 * and screen. An artifact no member names is the group's own.
 */
function ownersOf(attempt: ReportSerialAttempt): ReadonlyMap<string, ReadonlySet<string>> {
  const cached = OWNERS.get(attempt);
  if (cached !== undefined) return cached;
  const owners = new Map<string, Set<string>>();
  const name = (id: string, testId: string): void => {
    const set = owners.get(id) ?? new Set<string>();
    set.add(testId);
    owners.set(id, set);
  };
  const stepOwner = new Map<string, string>();
  for (const member of attempt.members) {
    for (const step of member.steps) {
      stepOwner.set(step.id, member.testId);
      for (const id of step.artifacts) name(id, member.testId);
    }
    for (const id of [member.failure?.screenshot, member.failure?.screen]) if (id !== undefined) name(id, member.testId);
  }
  for (const artifact of attempt.artifacts) {
    const owner = artifact.producer.kind === 'step' ? stepOwner.get(artifact.producer.stepId) : undefined;
    if (owner !== undefined) name(artifact.id, owner);
  }
  OWNERS.set(attempt, owners);
  return owners;
}

/**
 * A member's own artifacts in a group attempt and the ones no member's
 * records name, in the attempt's order. A sibling's failure screenshot is
 * never a member's.
 */
function memberArtifacts(attempt: ReportSerialAttempt, testId: string): OwnedArtifact[] {
  const owners = ownersOf(attempt);
  const owned: OwnedArtifact[] = [];
  for (const artifact of attempt.artifacts) {
    const named = owners.get(artifact.id);
    if (named === undefined) owned.push({ artifact, shared: true });
    else if (named.has(testId)) owned.push({ artifact, shared: false });
  }
  return owned;
}

/** Whether an attempt ended the way the result did; a failure and a timeout are one verdict. */
function reachedVerdict(result: ReportResult['status'], attempt: AttemptView['status']): boolean {
  if (result === 'failed' || result === 'timed-out') return attempt === 'failed' || attempt === 'timed-out';
  return attempt === result;
}
