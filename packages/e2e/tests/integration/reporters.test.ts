/**
 * Reporter objects end to end: one sees the event stream and the finished
 * run with resolvable artifact paths, neither a throwing, a hanging, nor a
 * misbehaving reporter can touch the run's outcome, and one the run gave up
 * on is work left behind, which the CLI does not wait for.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { engineConfig } from '../helpers/fixture-config.ts';
import { createProject, runExisting, type FixtureProject } from '../helpers/run-project.ts';
import type { FinishedRun, Reporter, ReporterSummary, RunEvent } from '../../src/index.ts';

// The built runner's flag. It stays set for the rest of the process, so only the first reporter given up on can show it.
const abandonedModule = '@e2e-dev/core/lib/internal/abandoned';
const { leftWorkBehind } = (await import(abandonedModule)) as typeof import('@e2e-dev/core/lib/internal/abandoned');

const SUITE = `import { test, expect } from 'e2e';

test('shows the submit button', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByRole('button', { name: 'Submit' })).toBeVisible();
});
`;

describe('reporter objects', () => {
  let project: FixtureProject;

  beforeAll(() => {
    project = createProject({ 'tests/reporters.e2e.ts': SUITE });
  });

  afterAll(() => {
    project?.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('receives the event stream and the finished run, whose artifact paths resolve, and leaves no work behind', async () => {
    const events: RunEvent[] = [];
    let finished: FinishedRun | undefined;
    const recording: Reporter = {
      name: 'recording',
      onEvent: (event) => {
        events.push(event);
      },
      onRunFinished: async (run) => {
        finished = run;
        return [{ label: 'Results', text: 'https://example.test/runs/1' }];
      },
    };
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [recording],
        cache: 'off' as const,
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(leftWorkBehind()).toBe(false);
    expect(events[0]?.type).toBe('run-started');
    expect(events.at(-1)?.type).toBe('run-finished');
    expect(events.some((event) => event.type === 'test-finished')).toBe(true);

    expect(finished).toBeDefined();
    const run = finished!;
    expect(run.status).toBe('passed');
    expect(run.exitCode).toBe(0);
    expect(run.report).toBe(outcome.report);
    expect(run.reportPath).toBe(outcome.reportPath);
    // The document a reporter uploads is the file on disk, byte for byte.
    expect(JSON.parse(readFileSync(run.reportPath!, 'utf8'))).toEqual(run.report);
    expect(run.projectRoot).toBe(project.dir);
    expect(run.artifactsRoot).toBe(path.join(project.dir, '.e2e', 'results'));
    const artifacts = run.report.run.results.flatMap((result) =>
      result.attempts.flatMap((attempt) => attempt.artifacts),
    );
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      expect(artifact.path).toBeDefined();
      expect(existsSync(path.join(run.artifactsRoot, artifact.path!))).toBe(true);
    }
  }, 120_000);

  it('redacts the configured secrets, and fragments of them, in text a reporter brings from elsewhere', async () => {
    const token = 'reporter-redact-token-42';
    let redacted: string | undefined;
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine().engine),
        tests: 'tests/**/*.e2e.ts',
        secrets: { apiToken: token },
        reporters: [{ name: 'reading', onRunFinished: async (run) => void (redacted = run.redact(`fill('${token}') then '${token.slice(3, 15)}'`)) }],
        cache: 'off' as const,
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(redacted).toBeDefined();
    expect(redacted).not.toContain(token.slice(3, 15));
    expect(redacted).toContain('apiToken');
  }, 120_000);

  it('never calls a reporter when the run was forced to stop before reporting, so it leaves no work behind', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    force.abort();
    const onRunFinished = vi.fn(async () => undefined);
    await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine().engine),
        tests: 'tests/**/*.e2e.ts',
        reporters: [{ name: 'uploading', onRunFinished }],
        cache: 'off' as const,
      },
      runOptions: { forceSignal: force.signal },
    });

    expect(onRunFinished).not.toHaveBeenCalled();
    expect(leftWorkBehind()).toBe(false);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "uploading" abandoned: the run was forced to stop');
  }, 120_000);

  it('warns on stderr for a throwing, hanging, or malformed reporter, leaves the outcome alone, and records the hanging one as work left behind', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const throwing: Reporter = {
      name: 'throwing',
      onRunFinished: async () => {
        throw new Error('boom');
      },
    };
    let hangingSignal: AbortSignal | undefined;
    const hanging: Reporter = {
      name: 'hanging',
      onRunFinished: (_run, signal) => {
        hangingSignal = signal;
        return new Promise(() => undefined);
      },
    };
    // What untyped JavaScript hands back: not rows.
    const malformed = {
      name: 'malformed',
      onRunFinished: async () => [{ href: 'https://example.test' }, { label: 'ok', text: 'https://example.test/ok' }],
    } as unknown as Reporter;
    const scalar = { name: 'scalar', onRunFinished: async () => 'done' } as unknown as Reporter;
    const loud: Reporter = {
      name: 'loud',
      onEvent: () => {
        throw new Error('bang');
      },
    };
    const seen: RunEvent['type'][] = [];
    const quiet: Reporter = {
      name: 'quiet',
      onEvent: (event) => {
        seen.push(event.type);
      },
    };
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [throwing, hanging, malformed, scalar, loud, quiet],
        cache: 'off' as const,
      },
      runOptions: {
        reporterTimeout: 200,
        onEvent: () => {
          throw new Error('host bang');
        },
      },
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.status).toBe('passed');
    // The budget running out aborts the reporter's own signal, so it can stop its work.
    expect(hangingSignal?.aborted).toBe(true);
    expect(leftWorkBehind()).toBe(true);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "throwing" failed: boom');
    expect(written).toContain('e2e: reporter "hanging" did not finish within 200ms');
    expect(written).toContain('e2e: reporter "malformed" returned 1 row(s) without a label and text; dropped');
    expect(written).toContain('e2e: reporter "scalar" returned something other than summary rows; dropped');
    const loudLine = 'e2e: reporter "loud" threw on run-started: bang; ignoring it for the rest of the run';
    expect(written.split(loudLine)).toHaveLength(2);
    expect(written).toContain('e2e: reporter "onEvent" threw on run-started: host bang; ignoring it for the rest of the run');
    // The quarantine is per sink: the reporter beside the loud one and the host still see the whole run.
    expect(seen[0]).toBe('run-started');
    expect(seen).toContain('test-finished');
    expect(seen.at(-1)).toBe('run-finished');
  }, 120_000);

  it('abandons a reporter when the run is forced to stop', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    const uploading: Reporter = {
      name: 'uploading',
      onRunFinished: () => {
        // The second Ctrl-C lands while the upload is in flight.
        setTimeout(() => force.abort(), 50);
        return new Promise(() => undefined);
      },
    };
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine({ video: true }).engine),
        video: 'on' as const,
        tests: 'tests/**/*.e2e.ts',
        reporters: [uploading],
        cache: 'off' as const,
      },
      runOptions: { reporterTimeout: 30_000, forceSignal: force.signal },
    });

    expect(outcome.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('e2e: reporter "uploading" abandoned: the run was forced to stop');
  }, 120_000);

  it('hands every onSummary the rows of every report file and onRunFinished, in reporters order', async () => {
    const seen: Record<string, ReporterSummary> = {};
    const summary = (name: string): Reporter => ({ name, onSummary: (rows) => void (seen[name] = rows) });
    const uploading: Reporter = { name: 'uploading', onRunFinished: async () => [{ label: 'Results', text: 'https://example.test/runs/1' }] };
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine().engine),
        tests: 'tests/**/*.e2e.ts',
        reporters: [summary('socket'), 'junit', uploading, summary('overlay')],
        cache: 'off' as const,
      },
    });

    expect(outcome.exitCode).toBe(0);
    const rows = [
      { label: 'JUnit', text: path.join('.e2e', 'junit.xml') },
      { label: 'Results', text: 'https://example.test/runs/1' },
    ];
    expect(seen).toEqual({ socket: rows, overlay: rows });
  }, 120_000);

  it('runs no reporter that shows the run on the terminal in a quiet run, and still runs one that prints a document', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const shown = vi.fn();
    const printed = vi.fn(async () => undefined);
    try {
      const outcome = await runExisting(project, {
        config: {
          ...engineConfig(createFakeEngine().engine),
          tests: 'tests/**/*.e2e.ts',
          reporters: [
            { name: 'view', interactive: true, onEvent: () => undefined, onSummary: shown },
            { name: 'document', onRunFinished: printed },
          ],
          cache: 'off' as const,
        },
      });

      expect(outcome.exitCode).toBe(0);
      expect(shown).not.toHaveBeenCalled();
      expect(printed).toHaveBeenCalledOnce();
    } finally {
      stdout.mockRestore();
    }
  }, 120_000);

  it('gives report files a few seconds after a forced stop, then gives up on them', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    let aborted = false;
    let started = 0;
    let waited = 0;
    try {
      const outcome = await runExisting(project, {
        config: {
          ...engineConfig(createFakeEngine().engine),
          tests: 'tests/**/*.e2e.ts',
          reporters: [
            {
              name: 'stuck',
              reportFiles: (_run, signal) => {
                // The clock runs from the call, which the forced stop came before.
                started = Date.now();
                signal.addEventListener('abort', () => {
                  aborted = true;
                  waited = Date.now() - started;
                });
                return new Promise<never>(() => undefined);
              },
            },
          ],
          cache: 'off' as const,
        },
        runOptions: { forceSignal: force.signal, onEvent: (event) => { if (event.type === 'run-finished') force.abort(); } },
      });
      expect(outcome.exitCode).toBe(0);
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('e2e: reporter "stuck" abandoned: the run was forced to stop');
    } finally {
      stderr.mockRestore();
    }
    // Far short of the one-minute budget, and not at once.
    expect(waited).toBeGreaterThanOrEqual(4_500);
    expect(waited).toBeLessThan(30_000);
    expect(aborted).toBe(true);
  }, 120_000);

  it('writes report files after a forced stop, but never over report.json', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const force = new AbortController();
    // The second Ctrl-C lands once the report is on disk, before the reporters finish.
    const forceAtFinish = (event: RunEvent): void => {
      if (event.type === 'run-finished') force.abort();
    };
    const outcome = await runExisting(project, {
      config: {
        ...engineConfig(createFakeEngine().engine),
        tests: 'tests/**/*.e2e.ts',
        reporters: [
          {
            name: 'pages',
            reportFiles: (run) => [
              { path: 'reports/run.txt', content: run.report.run.status },
              { path: path.join(run.outputDir, 'report.json'), content: 'clobbered' },
            ],
          },
        ],
        cache: 'off' as const,
      },
      runOptions: { forceSignal: force.signal, onEvent: forceAtFinish },
    });

    expect(force.signal.aborted).toBe(true);
    expect(readFileSync(path.join(project.dir, 'reports', 'run.txt'), 'utf8')).toBe(outcome.report.run.status);
    expect(JSON.parse(readFileSync(outcome.reportPath!, 'utf8'))).toEqual(outcome.report);
    const written = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain(`e2e: reporter "pages" cannot write ${path.join(project.dir, '.e2e', 'report.json')}: it is the run's report`);
  }, 120_000);
});
