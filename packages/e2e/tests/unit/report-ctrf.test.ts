import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinishedRun } from '../../src/run-types.ts';
import type { Report1Document, ReportResult, ReportSerialGroup } from '../../src/report/build.ts';
import { ctrf, renderCtrfReport, type CtrfReportOptions } from '../../src/report/ctrf.ts';
import { listedInCi, outcome } from '../../src/report/outcome.ts';
import { assertValidCtrf } from '../helpers/ctrf-schema.ts';
import { REPORT_AT as AT, reportAttempt, reportDocument, reportError, reportResult, reportStep } from '../helpers/report.ts';

type Artifact = ReportResult['attempts'][number]['artifacts'][number];
type Json = Record<string, any>;

const RUN_ID = '0196a3b4-0000-7000-8000-000000000001';
const KEY = 'e2e-inc.e2e';
const LATER = '2026-01-01T00:00:05.000Z';

/** Renders, validates against the CTRF 0.3.0 schema and its retry rules, and parses. */
function render(document: Report1Document, options?: CtrfReportOptions): Json {
  const text = renderCtrfReport(document, options);
  expect(text.endsWith('\n')).toBe(true);
  const parsed = JSON.parse(text) as Json;
  assertValidCtrf(parsed);
  return parsed;
}

function doc(overrides: Partial<Report1Document['run']> = {}): Report1Document {
  return reportDocument({ id: RUN_ID, ...overrides });
}

function tests(document: Report1Document, options?: CtrfReportOptions): Json[] {
  return render(document, options).results.tests as Json[];
}

/** A report artifact; `path: undefined` makes one with no local file, as a hosted or withheld video has. */
function artifact(id: string, overrides: { [K in keyof Artifact]?: Artifact[K] | undefined } = {}): Artifact {
  const merged = { id, kind: 'screenshot', mediaType: 'image/png', path: `checkout/${id}.png`, redaction: 'complete', producer: { kind: 'attempt' }, ...overrides };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as unknown as Artifact;
}

describe('renderCtrfReport', () => {
  it('renders an empty run as a CTRF 0.3.0 document naming e2e, its run id and the run in extra', () => {
    const document = render(
      doc({
        startedAt: AT,
        finishedAt: LATER,
        durationMs: 5000,
        runner: { name: 'e2e', version: '1.2.3' },
        environment: { ci: true, trustNoticeShown: false, os: 'darwin 25.1.0', arch: 'arm64', runtime: 'node' },
        vcs: { commit: 'a'.repeat(40), branch: 'main' },
        usage: { ...doc().run.usage, modelTokens: 10, modelCachedTokens: 4, estimatedCostUsd: 0.5 },
      }),
    );
    expect(document).toMatchObject({
      reportFormat: 'CTRF',
      specVersion: '0.3.0',
      reportId: RUN_ID,
      timestamp: LATER,
      generatedBy: 'e2e',
      results: {
        tool: { name: 'e2e', version: '1.2.3' },
        summary: { tests: 0, passed: 0, failed: 0, skipped: 0, pending: 0, other: 0, flaky: 0, suites: 0, start: Date.parse(AT), stop: Date.parse(LATER), duration: 5000 },
        tests: [],
        environment: { commit: 'a'.repeat(40), branchName: 'main', osPlatform: 'darwin', osRelease: '25.1.0' },
      },
      extra: { [KEY]: { runId: RUN_ID, status: 'passed', exitCode: 0, configDigest: '0'.repeat(64), usage: { modelTokens: 10, modelCachedTokens: 4, estimatedCostUsd: 0.5 } } },
    });
    expect(document).not.toHaveProperty('runId');
    expect(document.results).not.toHaveProperty('errors');
  });

  it('renders a passed result as one test named by file, title path, target and agent, keyed by the result id', () => {
    const [test] = tests(doc({ results: [reportResult({ agent: 'buyer', repeat: 2, tags: ['smoke'], attempts: [reportAttempt({ id: 'attempt-a' })] })] }));
    expect(test).toEqual({
      testId: 'result-1',
      attemptId: 'attempt-a',
      name: 'tests/auth.e2e.ts > auth > signs in (repeat #2) [web] [buyer]',
      status: 'passed',
      rawStatus: 'passed',
      duration: 1234,
      start: Date.parse(AT),
      stop: Date.parse(AT) + 1234,
      suite: ['tests/auth.e2e.ts', 'auth'],
      line: 3,
      tags: ['smoke'],
      labels: { target: 'web', platform: 'web', agent: 'buyer', repeat: 2 },
      type: 'e2e',
      filePath: 'tests/auth.e2e.ts',
    });
  });

  it('leaves the agent out of the name when it is default and types a setup result as setup', () => {
    const [test] = tests(doc({ results: [reportResult({ kind: 'setup' })] }));
    expect(test).toMatchObject({ name: 'tests/auth.e2e.ts > auth > signs in [web]', type: 'setup', labels: { agent: 'default', repeat: 0 } });
  });

  it('counts suites from the tests the file lists, not from results the selection left out', () => {
    const other = reportResult({ id: 'result-2', file: 'tests/other.e2e.ts', selected: false, status: 'skipped', skip: { cause: 'filtered', reason: 'not selected' }, attempts: [] });
    expect(render(doc({ results: [reportResult(), other] })).results.summary).toMatchObject({ tests: 1, suites: 1 });
  });

  it('points filePath and line at the declaration when an imported module declares the test, and counts suites by collected file', () => {
    const cases = { file: 'tests/cases.ts', line: 6, column: 1 };
    const cart = reportResult({ id: 'result-1', file: 'tests/cart.e2e.ts', source: cases });
    const checkout = reportResult({ id: 'result-2', file: 'tests/checkout.e2e.ts', source: cases });
    const document = render(doc({ results: [cart, checkout] }));
    expect(document.results.tests).toEqual([
      expect.objectContaining({ filePath: 'tests/cases.ts', line: 6, suite: ['tests/cart.e2e.ts', 'auth'] }),
      expect.objectContaining({ filePath: 'tests/cases.ts', line: 6, suite: ['tests/checkout.e2e.ts', 'auth'] }),
    ]);
    expect(document.results.summary).toMatchObject({ tests: 2, suites: 2 });
  });

  it('counts one suite for a file whose tests sit in two describe blocks', () => {
    const checkout = reportResult({ id: 'result-1', titlePath: ['checkout', 'pays'] });
    const account = reportResult({ id: 'result-2', titlePath: ['account', 'logs in'] });
    expect(render(doc({ results: [checkout, account] })).results.summary).toMatchObject({ tests: 2, suites: 1 });
  });

  it('leaves a result the selection did not choose out, and keeps one a filter left out as skipped with the filter named', () => {
    const unselected = reportResult({ id: 'result-2', selected: false, status: 'skipped', skip: { cause: 'filtered', reason: 'file not selected' }, attempts: [] });
    const filtered = reportResult({ id: 'result-3', selected: false, status: 'skipped', skip: { cause: 'filtered', reason: '4% likely affected', filter: 'jev' }, attempts: [] });
    const document = render(doc({ results: [unselected, filtered] }));
    expect(document.results.tests).toEqual([
      expect.objectContaining({ testId: 'result-3', status: 'skipped', rawStatus: 'skipped', duration: 0, message: 'left out by filter jev: 4% likely affected', extra: { [KEY]: { skipCause: 'filtered' } } }),
    ]);
    expect(document.results.tests[0]).not.toHaveProperty('attemptId');
    expect(document.results.tests[0]).not.toHaveProperty('start');
    expect(document.results.summary).toMatchObject({ tests: 1, skipped: 1, suites: 1 });
  });

  it('represents a flaky result by its passing attempt, with the failed one before it in retryAttempts', () => {
    const [test] = tests(
      doc({
        results: [
          reportResult({
            status: 'flaky',
            attempts: [
              reportAttempt({ id: 'attempt-1', index: 0, status: 'failed', durationMs: 900, error: reportError({ message: 'button missing' }) }),
              reportAttempt({ id: 'attempt-2', index: 1, status: 'passed', startedAt: LATER, durationMs: 1100 }),
            ],
          }),
        ],
      }),
    );
    expect(test).toMatchObject({ status: 'passed', rawStatus: 'flaky', flaky: true, attemptId: 'attempt-2', duration: 1100, start: Date.parse(LATER), retries: 1 });
    expect(test).not.toHaveProperty('message');
    expect(test!.retryAttempts).toEqual([
      {
        attempt: 1,
        attemptId: 'attempt-1',
        status: 'failed',
        duration: 900,
        start: Date.parse(AT),
        stop: Date.parse(AT) + 900,
        message: 'button missing',
        trace: 'ASSERTION_FAILED: button missing',
        extra: { [KEY]: { status: 'failed' } },
      },
    ]);
  });

  it('counts flaky passes in the summary as passed and flaky', () => {
    const flaky = reportResult({ status: 'flaky', attempts: [reportAttempt({ status: 'failed', error: reportError() }), reportAttempt({ id: 'attempt-2', index: 1 })] });
    const document = render(doc({ results: [flaky, reportResult({ id: 'result-2' })] }));
    expect(document.results.summary).toMatchObject({ tests: 2, passed: 2, flaky: 1, failed: 0 });
  });

  it('maps a failed product verdict to failed with its message and the JUnit failure body as trace', () => {
    const step = reportStep({ status: 'failed', actor: 'launch-1', error: reportError({ message: 'cart is empty' }) });
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', error: reportError({ message: 'cart is empty', phase: 'body' }), steps: [step] })] })] }));
    expect(test).toMatchObject({ status: 'failed', rawStatus: 'failed', message: 'cart is empty', trace: 'ASSERTION_FAILED (body) on launch-1: cart is empty' });
    expect(test).not.toHaveProperty('extra');
    expect(test).not.toHaveProperty('retries');
    expect(test).not.toHaveProperty('retryAttempts');
  });

  it('names the session of the step that ended the attempt, as junit does, not of a later failed teardown step', () => {
    const body = reportStep({ id: 'body', status: 'failed', actor: 'launch-1', error: reportError({ code: 'ASSERTION_FAILED', phase: 'body' }) });
    const teardown = reportStep({ id: 'teardown', status: 'failed', actor: 'launch-2', phase: 'afterEach', error: reportError({ code: 'ENGINE_CRASHED', phase: 'afterEach' }) });
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [body, teardown], error: reportError({ phase: 'body' }) })] })] }));
    expect(test!.trace).toBe('ASSERTION_FAILED (body) on launch-1: expected "Sign in" to be visible');
  });

  it('keeps a harness failure failed, so a CI check reading failed counts goes red, and names its category', () => {
    const error = reportError({ category: 'infrastructure', code: 'ENGINE_CRASHED', message: 'browser went away' });
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', error })] })] }));
    expect(test).toMatchObject({ status: 'failed', rawStatus: 'failed', message: 'browser went away', trace: 'ENGINE_CRASHED: browser went away', extra: { [KEY]: { errorCategory: 'infrastructure' } } });
  });

  it('maps a timed-out result to failed and keeps the word in rawStatus', () => {
    const error = reportError({ category: 'test', code: 'TEST_TIMEOUT', message: 'took over 30s' });
    const [test] = tests(doc({ results: [reportResult({ status: 'timed-out', attempts: [reportAttempt({ status: 'timed-out', error })] })] }));
    expect(test).toMatchObject({ status: 'failed', rawStatus: 'timed-out', message: 'took over 30s' });
  });

  it('maps an interrupted result to other with why the run stopped, counted under other', () => {
    const error = reportError({ category: 'interrupted', code: 'INTERRUPTED', message: 'SIGINT' });
    const document = render(doc({ results: [reportResult({ status: 'interrupted', attempts: [reportAttempt({ status: 'interrupted', error })] })] }));
    expect(document.results.tests[0]).toMatchObject({ status: 'other', rawStatus: 'interrupted', message: 'interrupted: SIGINT' });
    expect(document.results.summary).toMatchObject({ other: 1, skipped: 0, failed: 0 });
  });

  it('represents a failed result by its failed attempt and counts a retry the run cut after it in extra, not in retryAttempts', () => {
    const [test] = tests(
      doc({
        results: [
          reportResult({
            status: 'failed',
            attempts: [
              reportAttempt({ id: 'attempt-1', status: 'failed', error: reportError(), steps: [reportStep({ api: 'first.step' })], artifacts: [artifact('first', { url: 'https://store.example/first' })] }),
              reportAttempt({ id: 'attempt-2', index: 1, status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED', message: 'SIGINT' }), steps: [reportStep({ api: 'cut.step' })], artifacts: [artifact('cut', { url: 'https://store.example/cut' })] }),
            ],
          }),
        ],
      }),
    );
    expect(test).toMatchObject({ attemptId: 'attempt-1', status: 'failed', extra: { [KEY]: { cutAttempts: 1 } } });
    expect(test).not.toHaveProperty('retryAttempts');
    // Steps and attachments are the represented attempt's, not the cut one's.
    expect(test!.steps.map((step: Json) => step.name)).toEqual(['first.step tap Sign in']);
    expect(test!.attachments.map((file: Json) => file.name)).toEqual(['screenshot-first']);
  });

  it('keeps the expected failure of the represented attempt when a retry the run cut after it set none', () => {
    const marked = reportAttempt({ id: 'attempt-1', status: 'failed', error: reportError({ code: 'UNEXPECTED_PASS' }), expectedFailure: { reason: 'known bug' } });
    const cut = reportAttempt({ id: 'attempt-2', index: 1, status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED' }) });
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [marked, cut] })] }));
    expect(test).toMatchObject({ attemptId: 'attempt-1', extra: { [KEY]: { cutAttempts: 1, expectedFailure: { reason: 'known bug' } } } });
  });

  it('redacts the OS string before splitting it, so a value spanning the space is caught', () => {
    const redact = (text: string): string => text.replaceAll('darwin 25', '<secret:probe>');
    const document = render(doc({ environment: { ci: false, trustNoticeShown: false, os: 'darwin 25.1.0', arch: 'arm64', runtime: 'node' } }), { redact });
    expect(document.results.environment).toMatchObject({ osPlatform: '<secret:probe>.1.0' });
    expect(JSON.stringify(document.results.environment)).not.toContain('darwin');
  });

  it('says failed for a failed result with no attempt or error of its own, as junit does', () => {
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [] })] }));
    expect(test).toMatchObject({ status: 'failed', message: 'failed', duration: 0 });
    expect(test).not.toHaveProperty('trace');
  });

  it('marks a pass under test.fail with the expected failure it covered', () => {
    const attempt = reportAttempt({ expectedFailure: { reason: 'known bug', error: reportError({ code: 'ASSERTION_FAILED', message: 'still broken' }) } });
    const [test] = tests(doc({ results: [reportResult({ attempts: [attempt] })] }));
    expect(test).toMatchObject({ status: 'passed', extra: { [KEY]: { expectedFailure: { reason: 'known bug', code: 'ASSERTION_FAILED', message: 'still broken' } } } });
  });

  it('tells the test.step a step ran in by its position among the steps', () => {
    const steps = [
      reportStep({ id: 's0', index: 0, kind: 'step', api: 'test.step', label: 'Log in' }),
      reportStep({ id: 's1', index: 1, parent: 0 }),
    ];
    const [test] = tests(doc({ results: [reportResult({ attempts: [reportAttempt({ steps })] })] }));
    expect(test!.steps.map((step: Json) => [step.name, step.extra[KEY].kind, step.extra[KEY].parent])).toEqual([
      ['test.step Log in', 'step', undefined],
      ['locator.tap tap Sign in', 'locator', 0],
    ]);
  });

  it('renders the represented attempt steps with CTRF statuses and the e2e status in extra', () => {
    const steps = [
      reportStep({ id: 's0', status: 'passed', cache: { mode: 'self-finalized', replayedActions: 1, totalActions: 1 } }),
      reportStep({ id: 's1', kind: 'agent', api: 'agent.act', label: 'open the cart', status: 'blocked', explanation: 'no key' }),
      reportStep({ id: 's2', api: 'expect', label: '', status: 'timed-out', error: reportError({ code: 'STEP_TIMEOUT' }) }),
      reportStep({ id: 's3', status: 'cancelled' }),
      reportStep({ id: 's4', status: 'failed' }),
    ];
    const [test] = tests(doc({ results: [reportResult({ status: 'failed', attempts: [reportAttempt({ status: 'failed', steps, error: reportError() })] })] }));
    expect(test!.steps).toEqual([
      { name: 'locator.tap tap Sign in', status: 'passed', extra: { [KEY]: { status: 'passed', kind: 'locator', durationMs: 100, cache: 'self-finalized' } } },
      { name: 'agent.act open the cart', status: 'other', extra: { [KEY]: { status: 'blocked', kind: 'agent', durationMs: 100, explanation: 'no key' } } },
      { name: 'expect', status: 'failed', extra: { [KEY]: { status: 'timed-out', kind: 'locator', durationMs: 100, code: 'STEP_TIMEOUT' } } },
      { name: 'locator.tap tap Sign in', status: 'other', extra: { [KEY]: { status: 'cancelled', kind: 'locator', durationMs: 100 } } },
      { name: 'locator.tap tap Sign in', status: 'failed', extra: { [KEY]: { status: 'failed', kind: 'locator', durationMs: 100 } } },
    ]);
  });

  it('keeps the error on an earlier attempt that failed or was interrupted, and none on one that was skipped or passed', () => {
    const attempts = [
      reportAttempt({ id: 'a1', index: 0, status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED', message: 'stopped' }) }),
      reportAttempt({ id: 'a2', index: 1, status: 'skipped', error: reportError({ message: 'not its own' }) }),
      reportAttempt({ id: 'a3', index: 2, status: 'passed', error: reportError({ message: 'not its own either' }) }),
      reportAttempt({ id: 'a4', index: 3, status: 'failed', error: reportError({ message: 'broke' }) }),
      reportAttempt({ id: 'a5', index: 4 }),
    ];
    const [test] = tests(doc({ results: [reportResult({ status: 'flaky', attempts })] }));
    expect(test!.retryAttempts.map((attempt: Json) => attempt.message)).toEqual(['stopped', undefined, undefined, 'broke']);
    expect(test!.retryAttempts.map((attempt: Json) => attempt.trace === undefined)).toEqual([false, true, true, false]);
  });

  it('writes no message or trace for a passed test whose attempt carries an error', () => {
    const [test] = tests(doc({ results: [reportResult({ attempts: [reportAttempt({ error: reportError({ message: 'covered' }) })] })] }));
    expect(test).not.toHaveProperty('message');
    expect(test).not.toHaveProperty('trace');
  });

  it('maps every earlier attempt status for retryAttempts, numbered from one', () => {
    const attempts = (['failed', 'timed-out', 'interrupted', 'skipped'] as const).map((status, index) => reportAttempt({ id: `attempt-${index}`, index, status }));
    const [test] = tests(doc({ results: [reportResult({ status: 'flaky', attempts: [...attempts, reportAttempt({ id: 'attempt-9', index: 4 })] })] }));
    expect(test!.retryAttempts.map((attempt: Json) => [attempt.attempt, attempt.status, attempt.extra[KEY].status])).toEqual([
      [1, 'failed', 'failed'],
      [2, 'failed', 'timed-out'],
      [3, 'other', 'interrupted'],
      [4, 'skipped', 'skipped'],
    ]);
    expect(test!.retries).toBe(4);
  });

  describe('run-level errors', () => {
    it('lists a startup failure in results.errors and counts no test, so the summary has nothing failed', () => {
      const error = reportError({ category: 'infrastructure', code: 'APP_UNREACHABLE', message: 'http://127.0.0.1:3000 did not answer', phase: 'launch' });
      const document = render(doc({ status: 'error', exitCode: 3, errors: [error] }));
      expect(document.results.errors).toEqual([
        { message: 'APP_UNREACHABLE (launch): http://127.0.0.1:3000 did not answer', extra: { [KEY]: { code: 'APP_UNREACHABLE', category: 'infrastructure', phase: 'launch' } } },
      ]);
      expect(document.results.tests).toEqual([]);
      expect(document.results.summary).toMatchObject({ tests: 0, failed: 0 });
      expect(document.extra[KEY]).toMatchObject({ status: 'error', exitCode: 3 });
    });

    it('keeps a teardown failure after a passing test out of the tests and their counts', () => {
      const error = reportError({ category: 'test', code: 'HOOK_FAILED', message: 'afterAll threw', phase: 'afterAll' });
      const document = render(doc({ status: 'failed', exitCode: 1, errors: [error], results: [reportResult()] }));
      expect(document.results.tests).toHaveLength(1);
      expect(document.results.summary).toMatchObject({ tests: 1, passed: 1, failed: 0 });
      expect(document.results.errors).toHaveLength(1);
    });
  });

  describe('attachments', () => {
    function attached(artifacts: Artifact[], options?: CtrfReportOptions): Json[] | undefined {
      return tests(doc({ results: [reportResult({ attempts: [reportAttempt({ artifacts })] })] }), options)[0]!.attachments;
    }

    it('links a hosted video by its URL, a store reference by its URL, and a local file below the artifacts directory', () => {
      const video = artifact('video-1', { kind: 'video', mediaType: 'video/webm', path: undefined, url: 'https://videos.example/v/1', redaction: 'incomplete' });
      const stored = artifact('shot-2', { ref: 'https://store.example/shot-2' });
      const local = artifact('shot-3', { ref: 'bucket-key-not-a-url' });
      expect(attached([video, stored, local], { artifactsDir: '.e2e/results' })).toEqual([
        { name: 'video-video-1', contentType: 'video/webm', path: 'https://videos.example/v/1', extra: { [KEY]: { kind: 'video', redaction: 'incomplete' } } },
        { name: 'screenshot-shot-2', contentType: 'image/png', path: 'https://store.example/shot-2', extra: { [KEY]: { kind: 'screenshot', redaction: 'complete' } } },
        { name: 'screenshot-shot-3', contentType: 'image/png', path: '.e2e/results/checkout/shot-3.png', extra: { [KEY]: { kind: 'screenshot', redaction: 'complete' } } },
      ]);
    });

    it('prefers a hosted URL to a store reference', () => {
      const both = artifact('video-3', { kind: 'video', mediaType: 'video/webm', path: undefined, url: 'https://videos.example/v/3', ref: 'https://store.example/v/3' });
      expect(attached([both])?.map((file) => file.path)).toEqual(['https://videos.example/v/3']);
    });

    it('keeps the attachments of an earlier attempt on its retryAttempts entry', () => {
      const shot = artifact('shot-9', { url: 'https://store.example/shot-9' });
      const [test] = tests(doc({ results: [reportResult({ status: 'flaky', attempts: [reportAttempt({ status: 'failed', error: reportError(), artifacts: [shot] }), reportAttempt({ id: 'attempt-2', index: 1 })] })] }));
      expect(test!.retryAttempts[0].attachments).toEqual([expect.objectContaining({ name: 'screenshot-shot-9', path: 'https://store.example/shot-9' })]);
      expect(test).not.toHaveProperty('attachments');
    });

    it('leaves out a local link the run redaction would change, and redacts every text the file copies from the report', () => {
      const S = 'Zr8Kq2';
      const redact = (text: string): string => text.replaceAll(S, '<secret:probe>');
      const step = reportStep({ api: `api.${S}`, label: `label ${S}`, actor: `actor-${S}`, explanation: `why ${S}`, status: 'failed', error: reportError({ code: `CODE_${S}`, message: `step ${S}` }) });
      const failed = reportResult({
        id: `result-${S}`,
        file: `tests/${S}.e2e.ts`,
        source: { file: `tests/${S}-cases.ts`, line: 3, column: 1 },
        titlePath: [`describe ${S}`, `as ${S}`],
        tags: [S],
        targetId: `web-${S}`,
        platform: `plat-${S}`,
        agent: `agent-${S}`,
        status: 'flaky',
        attempts: [
          reportAttempt({ id: `attempt-${S}`, status: 'failed', steps: [step], error: reportError({ code: `CODE_${S}`, message: `saw ${S}` }), artifacts: [artifact(`shot-${S}`, { url: 'https://store.example/plain', mediaType: `image/${S}` }), artifact('hosted', { url: `https://store.example/${S}` }), artifact('shot-local')] }),
          reportAttempt({
            id: `attempt-2-${S}`,
            index: 1,
            expectedFailure: { reason: `known ${S}`, error: reportError({ code: `CODE_${S}`, message: `still ${S}` }) },
            artifacts: [artifact(`final-${S}`, { url: 'https://store.example/final', mediaType: `video/${S}` }), artifact('final-hosted', { url: `https://store.example/final-${S}` })],
          }),
        ],
      });
      const skipped = reportResult({ id: 'result-2', status: 'skipped', skip: { cause: 'filtered', reason: `reason ${S}`, filter: `filter-${S}` }, selected: false, attempts: [] });
      const broken = reportResult({ id: 'result-4', testId: 'test-4', titlePath: ['broken'], status: 'failed', attempts: [reportAttempt({ status: 'failed', steps: [step], error: reportError({ code: `CODE_${S}`, message: `failed ${S}` }) })] });
      const stopped = reportResult({ id: 'result-3', status: 'interrupted', attempts: [reportAttempt({ status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED', message: `stopped ${S}` }) })] });
      const document = render(
        doc({
          runner: { name: 'e2e', version: `1.0.0-${S}` },
          vcs: { commit: `${'a'.repeat(40)}${S}`, branch: `branch-${S}` },
          environment: { ci: false, trustNoticeShown: false, os: `os-${S} release-${S}`, arch: 'x64', runtime: 'node' },
          errors: [reportError({ code: `RUN_${S}`, message: `run ${S}`, phase: 'afterAll' })],
          results: [failed, skipped, stopped, broken],
        }),
        { artifactsDir: `out-${S}/results`, redact },
      );
      const text = JSON.stringify(document);
      expect(text).not.toContain(S);
      // One marker per planted text that reaches the file: a field that skipped the redaction changes the count.
      expect(text.split('<secret:probe>').length - 1).toBe(46);
      const brokenTest = (document.results.tests as Json[]).find((test) => test.testId === 'result-4')!;
      expect(brokenTest).toMatchObject({
        message: 'failed <secret:probe>',
        trace: 'CODE_<secret:probe> on actor-<secret:probe>: failed <secret:probe>',
        steps: [{ name: 'api.<secret:probe> label <secret:probe>', extra: { [KEY]: { actor: 'actor-<secret:probe>', code: 'CODE_<secret:probe>', explanation: 'why <secret:probe>' } } }],
      });
      // The test object's own attempt: its id, the attachment name and media type are redacted, and a link holding the value is left out.
      expect(document.results.tests[0]).toMatchObject({ attemptId: 'attempt-2-<secret:probe>' });
      expect(document.results.tests[0].attachments).toEqual([expect.objectContaining({ name: 'screenshot-final-<secret:probe>', contentType: 'video/<secret:probe>', path: 'https://store.example/final' })]);
      expect(document.results.environment.commit).toBe(`${'a'.repeat(40)}<secret:probe>`);
      // A link that holds the value is left out, hosted or local; a name that holds it is redacted.
      expect(document.results.tests[0].retryAttempts[0].attachments).toEqual([expect.objectContaining({ name: 'screenshot-shot-<secret:probe>', path: 'https://store.example/plain' })]);
    });

    it('checks the redaction again after terminal controls are taken out, which can join a value back together', () => {
      const redact = (text: string): string => text.replaceAll('Zr8Kq2', '<secret:probe>');
      const [test] = tests(doc({ results: [reportResult({ titlePath: ['auth', 'as Zr8\u001b[31mKq2'] })] }), { redact });
      expect(test!.name).toBe('tests/auth.e2e.ts > auth > as <secret:probe> [web]');
    });

    it('leaves out a download, a withheld artifact, and a local file when no artifacts directory is known', () => {
      const download = artifact('dl-1', { kind: 'download', mediaType: 'text/plain', redaction: 'incomplete' });
      const withheld = artifact('video-2', { kind: 'video', mediaType: 'video/webm', path: undefined, redaction: 'incomplete' });
      expect(attached([download, withheld], { artifactsDir: '.e2e/results' })).toBeUndefined();
      expect(attached([artifact('shot-1')])).toBeUndefined();
    });
  });

  describe('serial group members', () => {
    /** A group of two: `adds` (test-1) then `pays` (test-2), over the given attempts. */
    function group(attempts: ReportSerialGroup['attempts'], status: ReportSerialGroup['status']): ReportSerialGroup {
      return {
        id: 'group-1',
        serialId: 'checkout',
        declarationIndex: 0,
        file: 'tests/checkout.e2e.ts',
        source: { file: 'tests/checkout.e2e.ts', line: 1, column: 1 },
        titlePath: ['checkout'],
        targetId: 'web',
        platform: 'web',
        agent: 'default',
        repeat: 0,
        memberTestIds: ['test-1', 'test-2'],
        status,
        attempts,
      };
    }

    type Member = ReportSerialGroup['attempts'][number]['members'][number];

    function member(testId: string, overrides: Partial<Member> = {}): Member {
      return { id: `${testId}-member`, index: testId === 'test-1' ? 0 : 1, testId, status: 'passed', startedAt: AT, durationMs: 1000, steps: [], secondaryErrors: [], ...overrides };
    }

    function groupAttempt(id: string, members: Member[], overrides: Partial<ReportSerialGroup['attempts'][number]> = {}): ReportSerialGroup['attempts'][number] {
      return { id, index: 0, status: 'passed', startedAt: AT, durationMs: 2000, members, artifacts: [], secondaryErrors: [], cleanup: 'complete', ...overrides };
    }

    function memberResults(serial: ReportSerialGroup, statuses: [ReportResult['status'], ReportResult['status']], skip?: ReportResult['skip']): ReportResult[] {
      return [
        reportResult({ id: 'result-1', testId: 'test-1', file: 'tests/checkout.e2e.ts', titlePath: ['checkout', 'adds'], serialGroupId: serial.id, status: statuses[0], attempts: [] }),
        reportResult({ id: 'result-2', testId: 'test-2', declarationIndex: 1, file: 'tests/checkout.e2e.ts', titlePath: ['checkout', 'pays'], serialGroupId: serial.id, status: statuses[1], attempts: [], ...(skip === undefined ? {} : { skip }) }),
      ];
    }

    it('lists only a member its own artifacts, never a sibling failure screenshot, and the group video under each member that ran', () => {
      const ownShot = artifact('adds-shot', { producer: { kind: 'step', stepId: 'adds-step' } });
      const named = artifact('adds-named');
      const failShot = artifact('pays-failure');
      const screen = artifact('pays-screen', { kind: 'log', mediaType: 'text/plain' });
      const paysStep = artifact('pays-step-shot');
      const video = artifact('group-video', { kind: 'video', mediaType: 'video/webm', path: 'checkout/video.webm', redaction: 'incomplete' });
      const attempt = groupAttempt(
        'group-attempt-1',
        [
          member('test-1', { steps: [reportStep({ id: 'adds-step', artifacts: ['adds-named'] })] }),
          member('test-2', {
            status: 'failed',
            error: reportError({ message: 'card declined' }),
            failure: { screenshot: 'pays-failure', screen: 'pays-screen' },
            steps: [reportStep({ id: 'pays-step', status: 'failed', artifacts: ['pays-step-shot'] })],
          }),
        ],
        { status: 'failed', artifacts: [ownShot, named, failShot, screen, paysStep, video] },
      );
      const serial = group([attempt], 'failed');
      const [adds, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['passed', 'failed']) }), { artifactsDir: '.e2e/results' });
      const names = (test: Json | undefined): string[] => (test?.attachments ?? []).map((file: Json) => file.name);
      expect(names(adds)).toEqual(['screenshot-adds-shot', 'screenshot-adds-named', 'video-group-video']);
      expect(names(pays)).toEqual(['screenshot-pays-failure', 'log-pays-screen', 'screenshot-pays-step-shot', 'video-group-video']);
      expect(adds!.attachments.at(-1).extra[KEY]).toEqual({ kind: 'video', redaction: 'incomplete', scope: 'serial-group' });
      expect(adds!.attachments[0].extra[KEY]).not.toHaveProperty('scope');
      // Nothing the group attempt made is lost: together the members list every artifact.
      const listed = new Set([...names(adds), ...names(pays)]);
      expect(listed.size).toBe(attempt.artifacts.length);
      expect(adds).toMatchObject({ attemptId: 'test-1-member', status: 'passed', duration: 1000 });
      expect(pays).toMatchObject({ attemptId: 'test-2-member', status: 'failed', message: 'card declined' });
    });

    it('takes a member flaky from its own records, not from the group status it inherits', () => {
      const first = groupAttempt('group-attempt-1', [member('test-1'), member('test-2', { status: 'failed', error: reportError({ message: 'card declined' }) })], { status: 'failed', error: reportError({ message: 'card declined' }) });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2' }), member('test-2', { id: 'test-2-member-2' })], { index: 1 });
      const serial = group([first, second], 'flaky');
      const document = render(doc({ serialGroups: [serial], results: memberResults(serial, ['flaky', 'flaky']) }));
      const [adds, pays] = document.results.tests as Json[];
      expect(adds).toMatchObject({ status: 'passed', rawStatus: 'flaky', attemptId: 'test-1-member-2', retries: 1 });
      expect(adds).not.toHaveProperty('flaky');
      // The group attempt's error is the sibling's: a member that passed carries none of it.
      expect(adds!.retryAttempts[0]).toEqual(expect.objectContaining({ status: 'passed' }));
      expect(adds!.retryAttempts[0]).not.toHaveProperty('message');
      expect(adds!.retryAttempts[0]).not.toHaveProperty('trace');
      expect(pays).toMatchObject({ status: 'passed', rawStatus: 'flaky', flaky: true, attemptId: 'test-2-member-2', retries: 1 });
      expect(pays!.retryAttempts[0]).toMatchObject({ status: 'failed', message: 'card declined' });
      expect(document.results.summary).toMatchObject({ passed: 2, flaky: 1 });
    });

    it('never counts a member flaky when it failed on its last attempt too', () => {
      const first = groupAttempt('group-attempt-1', [member('test-1', { status: 'failed', error: reportError() }), member('test-2', { status: 'skipped', durationMs: 0, skip: { cause: 'serial-predecessor-failed', reason: 'earlier failed' } })], { status: 'failed' });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2', status: 'failed', error: reportError() }), member('test-2', { id: 'test-2-member-2', status: 'skipped', durationMs: 0, skip: { cause: 'serial-predecessor-failed', reason: 'earlier failed' } })], { index: 1, status: 'failed' });
      const serial = group([first, second], 'failed');
      const [adds] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['failed', 'skipped']) }));
      expect(adds).toMatchObject({ status: 'failed', retries: 1 });
      expect(adds).not.toHaveProperty('flaky');
    });

    it('counts a retry the run cut after a member was skipped in cutAttempts, never in retryAttempts', () => {
      const skip = { cause: 'serial-predecessor-failed' as const, reason: 'an earlier test in the serial group failed' };
      const first = groupAttempt('group-attempt-1', [member('test-1'), member('test-2', { status: 'failed', error: reportError({ message: 'card declined' }) })], { status: 'failed' });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2', status: 'failed', error: reportError() }), member('test-2', { id: 'test-2-member-2', status: 'skipped', durationMs: 0, skip })], { index: 1, status: 'failed' });
      const third = groupAttempt('group-attempt-3', [member('test-1', { id: 'test-1-member-3' }), member('test-2', { id: 'test-2-member-3', status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED' }) })], { index: 2, status: 'interrupted', cutRetry: true });
      const serial = group([first, second, third], 'failed');
      const [, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['failed', 'skipped'], skip) }));
      expect(pays).toMatchObject({ status: 'skipped', retries: 1, extra: { [KEY]: { cutAttempts: 1 } } });
      expect(pays!.retryAttempts.map((attempt: Json) => [attempt.attemptId, attempt.status])).toEqual([['test-2-member', 'failed']]);
    });

    it('counts no cut retry for a member the cut retry never reached', () => {
      const skip = { cause: 'serial-predecessor-failed' as const, reason: 'an earlier test in the serial group failed' };
      const first = groupAttempt('group-attempt-1', [member('test-1'), member('test-2', { status: 'failed', error: reportError({ message: 'card declined' }) })], { status: 'failed' });
      const cut = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2', status: 'interrupted', error: reportError({ category: 'interrupted', code: 'INTERRUPTED' }) }), member('test-2', { id: 'test-2-member-2', status: 'skipped', durationMs: 0, skip })], { index: 1, status: 'interrupted', cutRetry: true });
      const serial = group([first, cut], 'failed');
      const [, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['failed', 'failed']) }));
      expect(pays).toMatchObject({ status: 'failed', attemptId: 'test-2-member', message: 'card declined' });
      expect(pays).not.toHaveProperty('extra');
    });

    it('keeps the attempt of a member that skipped itself, which ran', () => {
      const skip = { cause: 'explicit' as const, reason: 'not on this plan' };
      const attempt = groupAttempt('group-attempt-1', [member('test-1'), member('test-2', { status: 'skipped', durationMs: 7, skip, steps: [reportStep({ id: 'pays-step' })] })]);
      const serial = group([attempt], 'passed');
      const [, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['passed', 'skipped'], skip) }));
      expect(pays).toMatchObject({ status: 'skipped', attemptId: 'test-2-member', duration: 7, start: Date.parse(AT), message: 'not on this plan', steps: [expect.objectContaining({ status: 'passed' })] });
    });

    it('counts a member flaky from its own records in a group that failed', () => {
      const first = groupAttempt('group-attempt-1', [member('test-1', { status: 'failed', error: reportError() }), member('test-2', { status: 'skipped', durationMs: 0, skip: { cause: 'serial-predecessor-failed', reason: 'earlier failed' } })], { status: 'failed' });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2' }), member('test-2', { id: 'test-2-member-2', status: 'failed', error: reportError() })], { index: 1, status: 'failed' });
      const serial = group([first, second], 'failed');
      const document = render(doc({ serialGroups: [serial], results: memberResults(serial, ['passed', 'failed']) }));
      expect(document.results.tests[0]).toMatchObject({ status: 'passed', rawStatus: 'passed', flaky: true });
      expect(document.results.summary).toMatchObject({ flaky: 1 });
    });

    it('counts a member flaky when an earlier attempt of its own timed out', () => {
      const first = groupAttempt('group-attempt-1', [member('test-1', { status: 'timed-out', error: reportError({ code: 'TEST_TIMEOUT' }) }), member('test-2', { status: 'skipped', durationMs: 0, skip: { cause: 'serial-predecessor-failed', reason: 'earlier failed' } })], { status: 'timed-out' });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2' }), member('test-2', { id: 'test-2-member-2' })], { index: 1 });
      const serial = group([first, second], 'flaky');
      const [adds] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['flaky', 'flaky']) }));
      expect(adds).toMatchObject({ flaky: true, retries: 1 });
    });

    it('keeps a member a later retry skipped as skipped, standing for that skipped attempt, with the attempt it ran and failed as its retryAttempts', () => {
      const skip = { cause: 'serial-predecessor-failed' as const, reason: 'an earlier test in the serial group failed' };
      const failShot = artifact('pays-failure');
      const first = groupAttempt(
        'group-attempt-1',
        [member('test-1'), member('test-2', { status: 'failed', error: reportError({ message: 'card declined' }), failure: { screenshot: 'pays-failure' } })],
        { status: 'failed', error: reportError({ message: 'card declined' }), artifacts: [failShot] },
      );
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2', status: 'failed', error: reportError({ message: 'cart empty' }) }), member('test-2', { id: 'test-2-member-2', status: 'skipped', durationMs: 0, skip })], { index: 1, status: 'failed', error: reportError({ message: 'cart empty' }) });
      const serial = group([first, second], 'failed');
      const [, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['failed', 'skipped'], skip) }), { artifactsDir: '.e2e/results' });
      expect(pays).toMatchObject({ status: 'skipped', duration: 0, message: 'an earlier test in the serial group failed', retries: 1 });
      for (const field of ['attemptId', 'start', 'attachments', 'trace']) expect(pays).not.toHaveProperty(field);
      expect(pays!.retryAttempts).toEqual([
        expect.objectContaining({ attempt: 1, attemptId: 'test-2-member', status: 'failed', message: 'card declined', attachments: [expect.objectContaining({ name: 'screenshot-pays-failure' })] }),
      ]);
    });

    it('gives a member the group never reached no attempt, no attachments, and no retries', () => {
      const video = artifact('group-video', { kind: 'video', mediaType: 'video/webm', url: 'https://videos.example/v' });
      const skip = { cause: 'serial-predecessor-failed' as const, reason: 'an earlier test in the serial group failed' };
      const attempt = groupAttempt('group-attempt-1', [member('test-1', { status: 'failed', error: reportError() }), member('test-2', { status: 'skipped', durationMs: 0, skip })], { status: 'failed', artifacts: [video] });
      const serial = group([attempt], 'failed');
      const [, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['failed', 'skipped'], skip) }));
      expect(pays).toMatchObject({ status: 'skipped', duration: 0, message: 'an earlier test in the serial group failed' });
      for (const field of ['attemptId', 'start', 'attachments', 'retries', 'retryAttempts']) expect(pays).not.toHaveProperty(field);
    });

    it('leaves a group attempt that never reached a member out of its retryAttempts', () => {
      const skip = { cause: 'serial-predecessor-failed' as const, reason: 'an earlier test in the serial group failed' };
      const first = groupAttempt('group-attempt-1', [member('test-1', { status: 'failed', error: reportError() }), member('test-2', { status: 'skipped', durationMs: 0, skip })], { status: 'failed' });
      const second = groupAttempt('group-attempt-2', [member('test-1', { id: 'test-1-member-2' }), member('test-2', { id: 'test-2-member-2' })], { index: 1 });
      const serial = group([first, second], 'flaky');
      const [adds, pays] = tests(doc({ serialGroups: [serial], results: memberResults(serial, ['flaky', 'flaky']) }));
      expect(adds).toMatchObject({ flaky: true, retries: 1 });
      expect(pays).toMatchObject({ attemptId: 'test-2-member-2' });
      expect(pays).not.toHaveProperty('retryAttempts');
      expect(pays).not.toHaveProperty('flaky');
    });
  });

  it('replaces terminal controls in text from the report', () => {
    const [test] = tests(doc({ results: [reportResult({ titlePath: ['auth', 'signs \u001b[31min'], status: 'failed', attempts: [reportAttempt({ status: 'failed', error: reportError({ message: 'red \u0007bell' }) })] })] }));
    expect(test!.name).toBe('tests/auth.e2e.ts > auth > signs in [web]');
    expect(test!.message).not.toContain('\u0007');
  });
});

describe('outcome', () => {
  it('works out no artifacts for a serial member the group attempt never reached, not even the group video', () => {
    const video = artifact('group-video', { kind: 'video', mediaType: 'video/webm' });
    const members = [
      { id: 'm1', index: 0, testId: 'test-1', status: 'failed' as const, startedAt: AT, durationMs: 1, steps: [], secondaryErrors: [] },
      { id: 'm2', index: 1, testId: 'test-2', status: 'skipped' as const, startedAt: AT, durationMs: 0, steps: [], secondaryErrors: [], skip: { cause: 'serial-predecessor-failed' as const, reason: 'earlier failed' } },
    ];
    const serial: ReportSerialGroup = {
      id: 'group-1', serialId: 's', declarationIndex: 0, file: 'tests/checkout.e2e.ts', source: { file: 'tests/checkout.e2e.ts', line: 1, column: 1 }, titlePath: ['s'],
      targetId: 'web', platform: 'web', agent: 'default', repeat: 0, memberTestIds: ['test-1', 'test-2'], status: 'failed',
      attempts: [{ id: 'g1', index: 0, status: 'failed', startedAt: AT, durationMs: 1, members, artifacts: [video], secondaryErrors: [], cleanup: 'complete' }],
    };
    const groups = new Map([[serial.id, serial]]);
    const ran = outcome(reportResult({ testId: 'test-1', serialGroupId: 'group-1', status: 'failed', attempts: [] }), groups).attempts[0]!;
    const unreached = outcome(reportResult({ testId: 'test-2', serialGroupId: 'group-1', status: 'skipped', attempts: [] }), groups).attempts[0]!;
    expect(ran.owned).toEqual([{ artifact: video, shared: true }]);
    expect(unreached).toMatchObject({ ran: false, owned: [] });
  });

  it('lists a result in a CI file when the run selected it or a test filter left it out', () => {
    expect(listedInCi(reportResult())).toBe(true);
    expect(listedInCi(reportResult({ selected: false, skip: { cause: 'filtered', reason: 'r', filter: 'jev' } }))).toBe(true);
    expect(listedInCi(reportResult({ selected: false, skip: { cause: 'filtered', reason: 'r' } }))).toBe(false);
  });
});

describe('ctrf', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function finishedRun(reportPath: string | undefined): FinishedRun {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctrf-')));
    tmpDirs.push(root);
    const outputDir = path.join(root, '.e2e');
    const shot = artifact('shot-1', { path: 'checkout/shot-1.png' });
    return {
      status: 'passed',
      exitCode: 0,
      projectRoot: root,
      artifactsRoot: path.join(outputDir, 'results'),
      reportPath,
      outputDir,
      aiTracePath: undefined,
      report: doc({ results: [reportResult({ attempts: [reportAttempt({ artifacts: [shot] })] })] }),
      traces: new Map(),
      redact: (text) => text,
    };
  }

  it('writes ctrf.json beside report.json with artifact paths from the project root', async () => {
    vi.stubEnv('CI_PROJECT_DIR', undefined);
    const run = finishedRun('report.json');
    const files = await ctrf().reportFiles!(run, new AbortController().signal);
    expect(files).toMatchObject([{ path: path.join(run.outputDir, 'ctrf.json'), label: 'CTRF' }]);
    const document = JSON.parse(files[0]!.content) as Json;
    assertValidCtrf(document);
    expect(document.results.tests[0].attachments[0].path).toBe('.e2e/results/checkout/shot-1.png');
  });

  it('passes the run redaction to the file it writes', async () => {
    vi.stubEnv('CI_PROJECT_DIR', undefined);
    const run: FinishedRun = {
      ...finishedRun('report.json'),
      report: doc({ results: [reportResult({ titlePath: ['auth', 'as Zr8Kq2'] })] }),
      redact: (text) => text.replaceAll('Zr8Kq2', '<secret:probe>'),
    };
    const [file] = await ctrf().reportFiles!(run, new AbortController().signal);
    expect(file!.content).not.toContain('Zr8Kq2');
    expect(file!.content).toContain('auth > as <secret:probe> [web]');
  });

  it('writes to outputFile when given one, and nothing when the report itself was not written', async () => {
    const run = finishedRun('report.json');
    expect((await ctrf({ outputFile: 'reports/ctrf.json' }).reportFiles!(run, new AbortController().signal))[0]!.path).toBe('reports/ctrf.json');
    expect(await ctrf().reportFiles!(finishedRun(undefined), new AbortController().signal)).toEqual([]);
  });
});
