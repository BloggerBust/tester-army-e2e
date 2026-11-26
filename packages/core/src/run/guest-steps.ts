/**
 * The steps of another session a test drives beside its own, kept in the
 * test's own record: a `launch()` host's session tells the attempt running
 * around it of each step it takes, the way the test's own steps are told.
 * So the report, the live output, and the model usage of the test cover
 * every session it drove, each step under its session's name.
 *
 * The types here cross between two copies of this package, when a project
 * installs `@e2e-dev/core` beside `e2e`: plain data and functions only.
 */

import path from 'node:path';
import { redactSerializedError } from '../internal/errors.ts';
import { projectRelativePath, type SourceLocation } from '../internal/source.ts';
import type { SessionVideo } from './records.ts';
import type { StepProgress, StepProgressFact, StepRecord, StepRecorder } from './steps.ts';

/** What a session offers the attempt it joins. */
export interface GuestSession {
  /** The directory the session's step sources are relative to. */
  readonly root: string;
  /** Whether a step of the session is still running. */
  busy(): boolean;
  /** Fails the steps the test body left running, as the session's recorder fails its own, and returns the error that names them. */
  abandonRunning(): Error | undefined;
  /** Closes the session: cancels what runs on it, and hands over the video it recorded. */
  close(): Promise<void>;
}

/** What a host a test launched offers the attempt that takes charge of it. */
export interface GuestHost {
  close(): Promise<void>;
  /** Stops sharing the host's secrets. The attempt calls it at its own end, not at the host's: a test may close the host early and go on reading screens that show them. */
  release(): void;
}

/** Where a joined session's steps and videos go. */
export interface GuestSteps {
  /** Takes one progress notification of the session's own recorder, with its record of the step. */
  progress(progress: StepProgress, record: StepRecord): void;
  /**
   * Takes a video the session recorded. Resolves once the attempt holds its
   * own copy of a file: the session's host removes the original when it
   * closes.
   */
  video(recording: SessionVideo): Promise<void>;
}

/**
 * A place in an attempt, reserved the moment a test starts opening a host or
 * a session, so what is opened is that test's however long the opening
 * takes, and sessions are named in the order the test opened them.
 */
export interface GuestSeat<Opened, Taken> {
  /** Aborts when the attempt will no longer take what is being opened: the opening is cancelled with it. */
  readonly signal: AbortSignal;
  /**
   * Hands over what was opened: the attempt owns its end from here, and
   * closes it if the test does not. Returns nothing when the attempt gave
   * the seat up meanwhile, and what was opened is the caller's to close.
   */
  take(opened: Opened): Taken | undefined;
  /**
   * Gives the seat back after the opening failed and its rejection reached
   * the caller: nothing was opened, so nothing of it is left running in the
   * test. Optional, since the attempt offering the seat may come from
   * another installed copy of the package.
   */
  release?(): void;
}

/** What an attempt offers the hosts and sessions a test opens beside its own with `launch()`. */
export interface AttemptGuests {
  /** Whether the attempt keeps a video of each session opened in it, so one opened now records. */
  readonly video: boolean;
  /** Reserves a seat for a host the test is launching. */
  host(): GuestSeat<GuestHost, true>;
  /** Reserves a seat, and the next name, for a session the test is opening. */
  session(): GuestSeat<GuestSession, GuestSteps>;
  /**
   * Says an opening failed because the attempt gave up its seat: the error is
   * the attempt's doing and already told, so a caller that never awaited the
   * opening must not meet it as a rejection nobody handled.
   */
  gaveUp(error: unknown): void;
  /**
   * Takes in a session opened outside every test, for the steps it runs
   * during this attempt. Nothing else of it is the attempt's: it is neither
   * closed nor recorded on video, and a step it still runs when the attempt
   * ends is told as cancelled and left running.
   */
  visit(session: Pick<GuestSession, 'root'>): GuestSteps;
}

/**
 * What becomes of each field of a session's step record in the test's record
 * of the step. Exhaustive, so a field added to `StepRecord` is decided here.
 * - `own`: the test's: its place in the test's record, and when it started.
 * - `start`: told when the step starts.
 * - `told`: gathered as the step runs.
 * - `taken`: copied when the step ends.
 * - `dropped`: counts in the session's own step indexes or artifact ids.
 */
const FIELDS = {
  id: 'own', index: 'own', actor: 'own', parent: 'own', startedAt: 'own', phase: 'own',
  kind: 'start', api: 'start', label: 'start', source: 'start',
  events: 'told',
  status: 'taken', durationMs: 'taken', observationRevision: 'taken', observationTruncated: 'taken', explanation: 'taken',
  visionInput: 'taken', visionDegraded: 'taken', visionOnly: 'taken', viewport: 'taken', metrics: 'taken', cache: 'taken',
  turns: 'taken', model: 'taken', agent: 'taken', error: 'taken',
  screen: 'dropped', artifacts: 'dropped',
} as const satisfies Record<keyof StepRecord, 'own' | 'start' | 'told' | 'taken' | 'dropped'>;

type TakenField = { [Key in keyof typeof FIELDS]: (typeof FIELDS)[Key] extends 'taken' ? Key : never }[keyof typeof FIELDS];

const TAKEN = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter((key): key is TakenField => FIELDS[key] === 'taken');

/** How a session's step went, as the test's record of it takes it. */
export type GuestResult = Pick<StepRecord, TakenField>;

/** A step of the session as the test's recorder lets it be told, once filed there (`StepRecorder.guest`). */
export interface GuestRecord {
  /** Tells of the step's progress; an event is kept on the step's record. */
  tell(progress: Exclude<StepProgressFact, { readonly phase: 'start' | 'end' }>): void;
  /** Ends the step with how it went. */
  end(result: GuestResult): void;
}

/** The mirror of one session's steps in a test's record. */
export interface GuestMirror {
  progress: GuestSteps['progress'];
  /** Ends the mirror: a step still running is told as cancelled, and what the session reports next is dropped. */
  cut(): void;
}

/**
 * Mirrors the steps of a session whose sources are relative to `root` into
 * `steps`, under `actor`. The prose the session reports (a label, an event,
 * an explanation, a model turn, a replay's detail, an error) is redacted
 * again by the test's recorder on the way in: the session may be another
 * copy of the package, or outlive the test's own, and then need not redact
 * what the test's does.
 */
export function mirrorGuestSteps(steps: StepRecorder, actor: string, root: string): GuestMirror {
  /** The session's running steps, by the id its own recorder gave them, each with when it started here. */
  const running = new Map<string, { readonly filed: GuestRecord; readonly startedMs: number }>();
  const redact = (text: string): string => steps.redactText(text);
  /** A line of the session's, read against the test's project root; nothing when it lies outside it. */
  const relocated = (source: SourceLocation | undefined): SourceLocation | undefined => {
    if (source === undefined || steps.projectRoot === undefined) return undefined;
    const file = projectRelativePath(steps.projectRoot, path.resolve(root, source.file));
    return file === undefined ? undefined : { ...source, file };
  };
  const resultOf = (theirs: StepRecord): GuestResult => {
    const result: GuestResult = { status: theirs.status, durationMs: theirs.durationMs };
    const take = <Key extends TakenField>(key: Key): void => {
      const value = theirs[key];
      if (value !== undefined) result[key] = structuredClone(value);
    };
    for (const key of TAKEN) take(key);
    if (result.explanation !== undefined) result.explanation = redact(result.explanation);
    if (result.turns !== undefined) result.turns = result.turns.map((turn) => ({ ...turn, calls: turn.calls.map(redact), outcome: redact(turn.outcome) }));
    if (result.cache?.detail !== undefined) result.cache = { ...result.cache, detail: redact(result.cache.detail) };
    if (result.error !== undefined) {
      const { source: theirSource, ...error } = redactSerializedError(result.error, redact);
      const source = relocated(theirSource);
      result.error = source === undefined ? error : { ...error, source };
    }
    return result;
  };
  let cut = false;
  return {
    progress: (progress, record) => {
      if (progress.phase === 'start') {
        if (cut) return;
        const filed = steps.guest({ kind: progress.kind, api: progress.api, label: progress.label, actor, source: relocated(record.source) });
        running.set(record.id, { filed, startedMs: Date.now() });
        return;
      }
      const step = running.get(record.id);
      if (step === undefined) return;
      if (progress.phase === 'event') {
        // The recorder redacts an event's detail as it keeps it; its reasoning is the other prose it carries.
        const { reasoning } = progress.event;
        step.filed.tell({ phase: 'event', api: progress.api, event: reasoning === undefined ? progress.event : { ...progress.event, reasoning: redact(reasoning) } });
        return;
      }
      if (progress.phase !== 'end') {
        const { identity: _theirs, ...told } = progress;
        step.filed.tell(told);
        return;
      }
      running.delete(record.id);
      step.filed.end(resultOf(record));
    },
    cut: () => {
      cut = true;
      for (const { filed, startedMs } of running.values()) filed.end({ status: 'cancelled', durationMs: Date.now() - startedMs });
      running.clear();
    },
  };
}
