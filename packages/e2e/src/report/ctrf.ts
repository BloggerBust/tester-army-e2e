/**
 * CTRF reporter: the report-1 document as `.e2e/ctrf.json`, in the Common
 * Test Report Format (https://ctrf.io), so any CTRF consumer reads e2e
 * results without knowing e2e. It reads the document only, as `junit` does:
 * no test source, no app output, and no CI variable but `CI_PROJECT_DIR`,
 * which `junit` resolves artifact paths against too.
 */

import path from 'node:path';
import { sanitizeRecordedText } from '@e2e-dev/core/lib/internal/errors';
import { builtin } from './builtin-id.ts';
import type { Reporter } from '../run-types.ts';
import type { Report1Document, ReportError, ReportResult, ReportSerialGroup, ReportStep } from './build.ts';
import { repeatSuffix } from './format.ts';
import { failedStepOf } from './failure-text.ts';
import { attachmentBase, errorBody as junitErrorBody, skippedMessage } from './junit.ts';
import { listedInCi, outcome, type AttemptView, type OwnedArtifact } from './outcome.ts';

/** The CTRF version every document claims. Pre-1.0 minors may break consumers, so moving it is its own change. */
const SPEC_VERSION = '0.3.0';

/** The one key e2e's data sits under in every CTRF `extra`, owner-prefixed as the spec asks. */
const EXTRA = 'e2e-inc.e2e';

type CtrfStatus = 'passed' | 'failed' | 'skipped' | 'pending' | 'other';
type Extra = Record<string, unknown>;

interface CtrfAttachment {
  name: string;
  contentType: string;
  path: string;
  extra: Extra;
}

interface CtrfStep {
  name: string;
  status: CtrfStatus;
  extra: Extra;
}

interface CtrfRetryAttempt {
  attempt: number;
  attemptId?: string;
  status: CtrfStatus;
  duration: number;
  start?: number;
  stop?: number;
  message?: string;
  trace?: string;
  attachments?: CtrfAttachment[];
  extra: Extra;
}

interface CtrfTest {
  testId: string;
  attemptId?: string;
  name: string;
  status: CtrfStatus;
  rawStatus: string;
  duration: number;
  start?: number;
  stop?: number;
  suite: string[];
  message?: string;
  trace?: string;
  line: number;
  tags: string[];
  labels: Record<string, string | number>;
  type: string;
  filePath: string;
  retries?: number;
  retryAttempts?: CtrfRetryAttempt[];
  flaky?: boolean;
  attachments?: CtrfAttachment[];
  steps?: CtrfStep[];
  extra?: Extra;
}

interface CtrfSummary {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  pending: number;
  other: number;
  flaky: number;
  suites: number;
  start: number;
  stop: number;
  duration?: number;
}

/** A CTRF 0.3.0 document. */
interface CtrfDocument {
  reportFormat: 'CTRF';
  specVersion: string;
  reportId: string;
  timestamp: string;
  generatedBy: string;
  results: {
    tool: { name: string; version: string };
    summary: CtrfSummary;
    tests: CtrfTest[];
    environment: Record<string, string>;
    errors?: { message: string; extra: Extra }[];
  };
  extra: Extra;
}

/** Options for rendering CTRF reports. */
export interface CtrfReportOptions {
  /**
   * Where artifact files are, relative to the project root (or `$CI_PROJECT_DIR`).
   * Without it, an artifact that has only a local file is left out of the
   * attachments, since the file's path would mean nothing to a reader.
   */
  readonly artifactsDir?: string | undefined;
  /**
   * The run's redaction (`FinishedRun.redact`), applied a second time to
   * every text the file copies from the report, before and after terminal
   * controls are replaced, since the file is made to be sent to other
   * services. A local link it would change is left out rather than broken.
   */
  readonly redact?: ((text: string) => string) | undefined;
}

/** Turns report text into what the file may carry: redacted, terminal controls replaced, then redacted again. */
type Clean = (text: string) => string;

/** `CODE (phase): message`, as `junit` writes it, with the session a failed step ran on when it is not the test's own. */
function errorBody(clean: Clean, error: ReportError, actor?: string): string {
  return clean(junitErrorBody(error, actor));
}

/** A result's status as CTRF reads it; `rawStatus` keeps the word itself. */
function resultStatus(status: ReportResult['status']): CtrfStatus {
  switch (status) {
    case 'passed':
    case 'flaky':
      return 'passed';
    case 'failed':
    case 'timed-out':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      return 'other';
  }
}

/** An attempt's status as CTRF reads it: a timeout failed, an interrupted attempt reached no verdict. */
function attemptStatus(status: AttemptView['status']): CtrfStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timed-out':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      return 'other';
  }
}

/** A step's status as CTRF reads it: a blocked step ran and was stopped before a verdict, which is not a skip. */
function stepStatus(status: ReportStep['status']): CtrfStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'timed-out':
      return 'failed';
    case 'blocked':
    case 'cancelled':
      return 'other';
  }
}

/** Epoch milliseconds of an ISO timestamp; undefined when there is none. */
function epoch(timestamp: string | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Where a reader finds an artifact: its hosted URL, the store's `http(s)` reference, else its file below `artifactsDir`. */
function attachmentPath(artifact: OwnedArtifact['artifact'], options: CtrfReportOptions): string | undefined {
  if (artifact.url !== undefined) return artifact.url;
  if (artifact.ref !== undefined && /^https?:\/\//i.test(artifact.ref)) return artifact.ref;
  if (artifact.path === undefined || options.artifactsDir === undefined) return undefined;
  return path.posix.join(options.artifactsDir, artifact.path);
}

/**
 * The attempt's artifacts as CTRF attachments. A download is left out: its
 * bytes are what the app served, unredacted unless they were text. An
 * artifact with nowhere a reader could open it is left out too.
 */
function attachments(view: AttemptView, options: CtrfReportOptions, clean: Clean): CtrfAttachment[] {
  const out: CtrfAttachment[] = [];
  for (const { artifact, shared } of view.owned) {
    if (artifact.kind === 'download') continue;
    const where = attachmentPath(artifact, options);
    // A path the redaction would change holds a secret; a link with a marker in it opens nothing.
    if (where === undefined || clean(where) !== where) continue;
    out.push({
      name: clean(`${artifact.kind}-${artifact.id}`),
      contentType: clean(artifact.mediaType),
      path: where,
      extra: { [EXTRA]: { kind: artifact.kind, redaction: artifact.redaction, ...(shared ? { scope: 'serial-group' } : {}) } },
    });
  }
  return out;
}

/** `api label`, or the api alone when the step has no label. */
function stepName(step: ReportStep, clean: Clean): string {
  return clean(step.label === '' ? step.api : `${step.api} ${step.label}`);
}

/** A step as a CTRF step, with e2e's own status, kind, timing, session, error code, cache mode and explanation in `extra`. */
function renderStep(step: ReportStep, clean: Clean): CtrfStep {
  return {
    name: stepName(step, clean),
    status: stepStatus(step.status),
    extra: {
      [EXTRA]: {
        status: step.status,
        kind: step.kind,
        durationMs: step.durationMs,
        ...(step.actor === undefined ? {} : { actor: clean(step.actor) }),
        ...(step.error === undefined ? {} : { code: clean(step.error.code) }),
        ...(step.cache === undefined ? {} : { cache: step.cache.mode }),
        ...(step.explanation === undefined ? {} : { explanation: clean(step.explanation) }),
      },
    },
  };
}

/** The session the step that ended the attempt ran on, matched as `junit` matches it. */
function failedStepActor(view: AttemptView): string | undefined {
  return failedStepOf(view)?.step.actor;
}

/** An attempt status whose error is its own: a member that passed or was skipped reads the group's, which is a sibling's. */
function endedOnError(status: AttemptView['status']): boolean {
  return status === 'failed' || status === 'timed-out' || status === 'interrupted';
}

/** The attempt's timing and identity fields, absent for a test that never ran. */
function attemptFields(view: AttemptView, clean: Clean): { attemptId?: string; start?: number; stop?: number; duration: number } {
  const start = epoch(view.startedAt);
  return {
    ...(view.id === undefined ? {} : { attemptId: clean(view.id) }),
    ...(start === undefined ? {} : { start, stop: start + view.durationMs }),
    duration: view.durationMs,
  };
}

/** An attempt before the represented one as a `retryAttempts` entry; its error shows only when the attempt itself ended on it. */
function renderRetryAttempt(view: AttemptView, number: number, options: CtrfReportOptions, clean: Clean): CtrfRetryAttempt {
  const files = attachments(view, options, clean);
  const error = endedOnError(view.status) ? view.error : undefined;
  return {
    attempt: number,
    status: attemptStatus(view.status),
    ...attemptFields(view, clean),
    ...(error === undefined ? {} : { message: clean(error.message), trace: errorBody(clean, error, failedStepActor(view)) }),
    ...(files.length === 0 ? {} : { attachments: files }),
    extra: { [EXTRA]: { status: view.status } },
  };
}

/**
 * The attempt the test object stands for, the test's own attempts before
 * it, and how many of its own come after (retries the run cut). It stands
 * for the outcome's verdict attempt, the last that reached the result's
 * verdict. A serial group attempt that never reached the member is not its
 * attempt: when the verdict attempt is one of those (a retry skipped the
 * member), the test stands for that skipped attempt, with no timing or
 * evidence of its own, and the ones it ran before are its retryAttempts.
 * CTRF retry entries can be `skipped`, so the skip counts as the final
 * attempt: `retries + 1` attempts in all.
 */
function representedAttempts(views: readonly AttemptView[], verdict: AttemptView): { before: AttemptView[]; represented: AttemptView | undefined; after: number } {
  const at = views.indexOf(verdict);
  if (at === -1) return { before: [], represented: undefined, after: 0 };
  return {
    before: views.slice(0, at).filter((view) => view.ran),
    represented: verdict.ran ? verdict : undefined,
    after: views.slice(at + 1).filter((view) => view.ran).length,
  };
}

/** A result as one CTRF test standing for its verdict attempt, with the attempts it ran before that as `retryAttempts`. */
function renderResult(result: ReportResult, groups: ReadonlyMap<string, ReportSerialGroup>, options: CtrfReportOptions, clean: Clean): CtrfTest {
  const view = outcome(result, groups);
  const { before, represented, after } = representedAttempts(view.attempts, view.verdict);
  const agent = result.agent === 'default' ? '' : ` [${result.agent}]`;
  const status = resultStatus(result.status);
  // A serial member takes the group's status, so whether it was flaky comes from its own records.
  const flaky =
    result.serialGroupId === undefined
      ? result.status === 'flaky'
      : represented?.status === 'passed' && before.some((attempt) => attempt.status === 'failed' || attempt.status === 'timed-out');
  // The represented attempt's mark: a retry the run cut after it set none of its own.
  const expected = result.attempts.find((attempt) => attempt.id === represented?.id)?.expectedFailure;
  const error = represented?.error;
  const message =
    result.status === 'skipped'
      ? clean(skippedMessage(result))
      : result.status === 'interrupted'
        ? clean(`interrupted: ${view.final.error?.message ?? 'the run was stopped'}`)
        : status === 'failed'
          ? // A result with no error of its own (a test that vanished before it ran) says its status, as `junit` does.
            clean(error?.message ?? result.status)
          : undefined;
  const files = represented === undefined ? [] : attachments(represented, options, clean);
  const steps = represented?.steps ?? [];
  const extra = {
    ...(status === 'failed' && error !== undefined && error.category !== 'test' ? { errorCategory: error.category } : {}),
    ...(expected === undefined ? {} : { expectedFailure: { reason: clean(expected.reason), ...(expected.error === undefined ? {} : { code: clean(expected.error.code), message: clean(expected.error.message) }) } }),
    ...(after === 0 ? {} : { cutAttempts: after }),
    ...(result.skip === undefined ? {} : { skipCause: result.skip.cause }),
  };
  return {
    testId: clean(result.id),
    name: clean(`${result.file} > ${result.titlePath.join(' > ')}${repeatSuffix(result.repeat)} [${result.targetId}]${agent}`),
    status,
    rawStatus: result.status,
    ...(represented === undefined ? { duration: 0 } : attemptFields(represented, clean)),
    suite: [result.file, ...result.titlePath.slice(0, -1)].map(clean),
    ...(message === undefined ? {} : { message }),
    ...(status === 'failed' && error !== undefined && represented !== undefined ? { trace: errorBody(clean, error, failedStepActor(represented)) } : {}),
    line: result.source.line,
    tags: result.tags.map(clean),
    labels: {
      target: clean(result.targetId),
      platform: clean(result.platform),
      agent: clean(result.agent),
      repeat: result.repeat,
    },
    type: result.kind === 'setup' ? 'setup' : 'e2e',
    filePath: clean(result.source.file),
    ...(before.length === 0 ? {} : { retries: before.length, retryAttempts: before.map((attempt, index) => renderRetryAttempt(attempt, index + 1, options, clean)) }),
    ...(flaky ? { flaky: true } : {}),
    ...(files.length === 0 ? {} : { attachments: files }),
    ...(steps.length === 0 ? {} : { steps: steps.map((step) => renderStep(step, clean)) }),
    ...(Object.keys(extra).length === 0 ? {} : { extra: { [EXTRA]: extra } }),
  };
}

/** `osPlatform` and `osRelease` from report-1's `os`, which joins them with a space; redacted before the cut, so no value spans the two. */
function osFields(os: string, clean: Clean): Record<string, string> {
  const text = clean(os);
  const space = text.indexOf(' ');
  if (space === -1) return { osPlatform: text };
  return { osPlatform: text.slice(0, space), osRelease: text.slice(space + 1) };
}

/**
 * Renders the report-1 document as a CTRF 0.3.0 document: one test per
 * `<testcase>` of `junit.xml` outside its `run` suite, each standing for one attempt
 * with the ones before it in `retryAttempts`. A run-level error never
 * becomes a test: the spec says global errors must not be counted as test
 * results, so each one is an entry of `results.errors`, and the run's exit
 * code stays the signal that it failed. Like every reporter it reads the
 * document, never runner state, and it can never change run status.
 */
export function renderCtrfReport(report: Report1Document, options: CtrfReportOptions = {}): string {
  const { run } = report;
  const { redact } = options;
  // Redacted before and after the controls go: taking one out can join the two halves of a value.
  const clean: Clean = redact === undefined ? sanitizeRecordedText : (text) => redact(sanitizeRecordedText(redact(text)));
  const groups = new Map(run.serialGroups.map((group) => [group.id, group]));
  const tests: CtrfTest[] = [];
  for (const result of run.results) {
    if (listedInCi(result)) tests.push(renderResult(result, groups, options, clean));
  }
  const count = (status: CtrfStatus): number => tests.filter((test) => test.status === status).length;
  const start = epoch(run.startedAt) ?? 0;
  const stop = epoch(run.finishedAt) ?? start;
  const document: CtrfDocument = {
    reportFormat: 'CTRF',
    specVersion: SPEC_VERSION,
    reportId: run.id,
    // No top-level runId: CTRF shares it across a run's shards, and run.id is minted per process, so each shard would read as its own run.
    timestamp: run.finishedAt,
    generatedBy: 'e2e',
    results: {
      tool: { name: 'e2e', version: clean(run.runner.version) },
      summary: {
        tests: tests.length,
        passed: count('passed'),
        failed: count('failed'),
        skipped: count('skipped'),
        pending: count('pending'),
        other: count('other'),
        flaky: tests.filter((test) => test.flaky === true).length,
        // A suite is a collected test file, the first entry of each test's `suite`.
        suites: new Set(tests.map((test) => test.suite[0])).size,
        start,
        stop,
        ...(run.durationMs === undefined ? {} : { duration: run.durationMs }),
      },
      tests,
      environment: {
        ...(run.vcs === undefined ? {} : { commit: clean(run.vcs.commit), ...(run.vcs.branch === undefined ? {} : { branchName: clean(run.vcs.branch) }) }),
        ...osFields(run.environment.os, clean),
      },
      ...(run.errors.length === 0
        ? {}
        : {
            errors: run.errors.map((error) => ({
              message: errorBody(clean, error),
              extra: { [EXTRA]: { code: clean(error.code), category: error.category, ...(error.phase === undefined ? {} : { phase: error.phase }) } },
            })),
          }),
    },
    extra: {
      [EXTRA]: {
        runId: run.id,
        status: run.status,
        exitCode: run.exitCode,
        configDigest: run.project.configDigest,
        usage: {
          modelTokens: run.usage.modelTokens,
          ...(run.usage.modelCachedTokens === undefined ? {} : { modelCachedTokens: run.usage.modelCachedTokens }),
          ...(run.usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: run.usage.estimatedCostUsd }),
        },
      },
    },
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Options of the built-in `ctrf` reporter. */
export interface CtrfReporterOptions {
  /** Where the JSON goes, from the project root; `ctrf.json` in the output directory by default. */
  readonly outputFile?: string;
}

/**
 * The built-in `ctrf` reporter: the report in the Common Test Report Format
 * in `ctrf.json` beside `report.json`, for any CTRF consumer. Writes nothing
 * when the report itself was not written.
 */
export function ctrf(options: CtrfReporterOptions = {}): Reporter {
  return builtin('ctrf', {
    name: 'ctrf',
    reportFiles: (run) =>
      run.reportPath === undefined
        ? []
        : [
            {
              path: options.outputFile ?? path.join(run.outputDir, 'ctrf.json'),
              content: renderCtrfReport(run.report, { artifactsDir: attachmentBase(run), redact: run.redact }),
              label: 'CTRF',
            },
          ],
  });
}
