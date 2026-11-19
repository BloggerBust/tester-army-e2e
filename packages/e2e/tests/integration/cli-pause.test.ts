/**
 * Exercises `screen.pause()` through the built CLI on the fake engine.
 * Without a terminal, the pause is printed and the run waits for a command
 * from the same directory. In CI, the test fails at the pause.
 *
 * Terminal cases run the built `servePauses` in this process with a stand-in
 * for stdin, both directly and through `watchSession`. Keys resume or stop
 * the run.
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import picocolors from 'picocolors';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { SecretLedger } from '@e2e-dev/core/lib/internal/redact';
import { stepAddress } from '../../src/run/step-socket.ts';
import { fakeStdin } from '../helpers/fake-stdin.ts';
import { createProject, workerFakeConfigSource, type FixtureProject } from '../helpers/run-project.ts';

const builtStepControl = '../../dist/cli/step-control.js';
const builtWatch = '../../dist/cli/watch.js';
const builtSignals = '../../dist/cli/signals.js';
const builtProcessOutput = '../../dist/run/process-output.js';
const { servePauses } = (await import(builtStepControl)) as typeof import('../../src/cli/step-control.ts');
const { watchSession } = (await import(builtWatch)) as typeof import('../../src/cli/watch.ts');
const { SignalLadder } = (await import(builtSignals)) as typeof import('../../src/cli/signals.ts');
const { RunnerOutput } = (await import(builtProcessOutput)) as typeof import('../../src/run/process-output.ts');

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const ENV = { ...process.env, CI: '', NO_COLOR: '1' };
const projects: FixtureProject[] = [];
const runs: ReturnType<typeof spawn>[] = [];
/**
 * Runs started in this process, with their stop functions. Cleanup stops
 * them before it sends commands that could block.
 */
const inProcess: { readonly stop: () => void; readonly done: Promise<unknown> }[] = [];

const TIMEOUT_MS = 1_500;
/** A delay long enough to pass `StepGate`'s 150 ms key guard on a busy machine. */
const KEY_GUARD_MS = 400;

const PAUSE_SUITE = `import { test } from 'e2e';

test('pauses past its timeout', async ({ app, screen }) => {
  await app.open('/one');
  await screen.pause();
  await app.open('/two');
});
`;

/** Creates a test that writes `mark` before pausing, so another test can wait for it. */
function pausingAfterMark(title: string, mark: string): string {
  return `import { writeFileSync } from 'node:fs';
import { test } from 'e2e';

test('${title}', async ({ app, screen }) => {
  await app.open('/');
  writeFileSync(new URL('../${mark}', import.meta.url), '');
  await screen.pause();
});
`;
}

/** Waits until every file in `marks` exists in `dir`. */
async function marked(dir: string, ...marks: string[]): Promise<void> {
  for (let tries = 0; tries < 600; tries += 1) {
    if (marks.every((mark) => existsSync(path.join(dir, mark)))) {
      break;
    }

    await sleep(50);
  }

  expect(marks.filter((mark) => !existsSync(path.join(dir, mark)))).toEqual([]);
}

/** Creates a test titled `title` that pauses `count` times. */
function pausing(title: string, count: number): string {
  return `import { test } from 'e2e';

test('${title}', async ({ app, screen }) => {
  await app.open('/');
${'  await screen.pause();\n'.repeat(count)}});
`;
}

/**
 * Creates a project with these files and config. Cleanup stops its runs
 * and removes it.
 */
function project(
  files: Readonly<Record<string, string>>,
  config = workerFakeConfigSource(1, `\n  timeout: ${TIMEOUT_MS},`),
): FixtureProject {
  const created = createProject({ 'e2e.config.ts': config, ...files });
  projects.push(created);

  return created;
}

/** Runs one CLI command in `dir` to completion. */
function e2e(dir: string, args: readonly string[], env: NodeJS.ProcessEnv = ENV) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });

  expect(result.error).toBeUndefined();

  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Waits until `output` shows `text`. */
async function waitForText(output: () => string, text: string): Promise<void> {
  for (let tries = 0; tries < 600; tries += 1) {
    if (output().includes(text)) {
      return;
    }

    await sleep(50);
  }

  throw new Error(`the run never printed ${text}; it printed:\n${output()}`);
}

/**
 * Starts a run in `dir` and returns its output, a way to wait for text,
 * and its exit.
 */
function start(dir: string, args: readonly string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  runs.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    shows: (text: string): Promise<void> => waitForText(() => stdout + stderr, text),
    exited,
  };
}

/** Starts `e2e run` in `dir` without a terminal and waits for its first pause. */
async function pausedRun(dir: string) {
  const run = start(dir, ['run']);
  await run.shows('Next: e2e run --step next');
  return run;
}

/** Spies on this process's terminal streams while a run in it prints; restored after each test. */
const terminalSpies: MockInstance[] = [];

/**
 * Captures output from the built runner in this process and waits for text
 * in it: the runner's own, and what its reporters print to this process's
 * streams.
 */
function terminalOutput() {
  let printed = '';
  const write = (text: string | Uint8Array): boolean => {
    printed += typeof text === 'string' ? text : Buffer.from(text).toString('utf8');
    return true;
  };
  for (const stream of [process.stdout, process.stderr]) {
    terminalSpies.push(vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => write(chunk)));
  }
  // Colors are on in this process when CI is set, so strip them before matching.
  const plain = (): string => stripVTControlCharacters(printed);

  return {
    processOutput: new RunnerOutput({ stdout: write, stderr: write }, new SecretLedger()),
    write: (text: string): void => void write(text),
    printed: plain,
    shows: (text: string): Promise<void> => waitForText(plain, text),
  };
}

/**
 * Runs `e2e run` in this process with `stdin` as the terminal. Returns its
 * output and result.
 */
function terminalRun(dir: string, stdin: NodeJS.ReadStream) {
  const output = terminalOutput();
  const interrupt = new AbortController();

  const outcome = servePauses(
    { cwd: dir, env: ENV, interruptSignal: interrupt.signal, processOutput: output.processOutput },
    () => interrupt.abort(),
    stdin,
  );

  inProcess.push({ stop: () => interrupt.abort(), done: outcome.catch(() => undefined) });

  return { ...output, outcome };
}

afterEach(async () => {
  for (const { stop, done } of inProcess.splice(0)) {
    stop();
    await done;
  }
  for (const spy of terminalSpies.splice(0)) {
    spy.mockRestore();
  }
  const created = projects.splice(0);

  // Stop runs before killing them. A kill while listening leaves a socket file.
  try {
    for (const { dir } of created) {
      e2e(dir, ['run', '--step', 'stop']);
    }

    for (const { dir } of created) {
      expect(existsSync(stepAddress(dir).socket), `the socket file of ${dir}`).toBe(false);
    }
  } finally {
    for (const child of runs.splice(0)) {
      child.kill('SIGKILL');
    }

    for (const { cleanup } of created) {
      cleanup();
    }
  }
});

describe('screen.pause() without a terminal', () => {
  it('pauses the test past its timeout, prints the pause and its screen, and resumes it on e2e run --step next', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const run = start(dir, ['run']);
    await run.shows('Next: e2e run --step next to resume the test');
    expect(run.stdout()).toContain('Paused in pauses past its timeout [fake]:\n  screen.pause() (tests/pause.e2e.ts:5)\nScreen:');
    expect(run.stdout()).toContain('button "Submit"');
    await sleep(TIMEOUT_MS + 500);

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain('1 passed (1)');

    const gone = e2e(dir, ['run', '--step', 'next']);
    expect(gone.exitCode).toBe(2);
    expect(gone.stderr).toContain('no run in this directory can be controlled with e2e run --step');
  }, 60_000);

  it('prints the pause to stderr with the json reporter, so stdout has only the report', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const run = start(dir, ['run', '--reporter', 'json']);
    await run.shows('Next: e2e run --step next to resume the test');
    expect(run.stderr()).toContain('Paused in pauses past its timeout [fake]:');

    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
    expect(run.stdout()).not.toContain('Paused in');
    expect(JSON.parse(run.stdout())).toMatchObject({ run: { results: [{ status: 'passed' }] } });
  }, 60_000);

  it('stops the run on e2e run --step stop', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const run = start(dir, ['run']);
    await run.shows('Paused in pauses past its timeout');

    const stopped = e2e(dir, ['run', '--step', 'stop']);
    expect(stopped.exitCode).toBe(130);
    expect(stopped.stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(130);
    expect(run.stdout()).toContain('1 interrupted');
  }, 60_000);

  it('resumes the paused test on next or rest alike, and lists only next and stop', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': pausing('pauses three times', 3) });
    const run = start(dir, ['run']);
    await run.shows('Paused in pauses three times');
    expect(run.stdout()).toContain('Next: e2e run --step next to resume the test, or e2e run --step stop to end the run.\n');

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain('Paused in pauses three times [fake]:\n  screen.pause() (tests/pause.e2e.ts:6)');

    const rest = e2e(dir, ['run', '--step', 'rest']);
    expect(rest.exitCode).toBe(0);
    expect(rest.stdout).toContain('Paused in pauses three times [fake]:\n  screen.pause() (tests/pause.e2e.ts:7)');

    expect(e2e(dir, ['run', '--step', 'rest']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
    expect(run.stdout().split('Paused in').length - 1).toBe(3);
  }, 60_000);

  it("says a command that came before a pause wasn't applied, and answers it at the next pause", async () => {
    const { dir } = project({
      'tests/pause.e2e.ts': `import { existsSync } from 'node:fs';
import { test } from 'e2e';

test('pauses after a wait', { timeout: 30_000 }, async ({ app, screen }) => {
  await app.open('/');
  await screen.pause();
  console.log('released the first pause');
  while (!existsSync(new URL('../go', import.meta.url))) await new Promise((resolve) => setTimeout(resolve, 50));
  await screen.pause();
});
`,
    });
    const run = start(dir, ['run']);
    await run.shows('Paused in pauses after a wait');
    const resumed = start(dir, ['run', '--step', 'next']);
    // Wait until the test is past the release and waiting in its loop, not paused.
    await run.shows('released the first pause');

    const early = net.connect(stepAddress(dir).socket);
    early.setEncoding('utf8');
    let reply = '';
    early.on('data', (chunk: string) => {
      reply += chunk;
    });
    const answered = once(early, 'close');
    await once(early, 'connect');
    await new Promise((resolve) => early.write('{"action":"next"}\n', resolve));
    // The run drops this connection, so it has read the command above before the next pause.
    const dropped = net.connect(stepAddress(dir).socket);
    dropped.on('error', () => undefined);
    await once(dropped, 'connect');
    dropped.write('not a command\n');
    await once(dropped, 'close');
    writeFileSync(path.join(dir, 'go'), '');
    await answered;
    const { text, exitCode } = JSON.parse(reply) as { text: string; exitCode: number };
    expect(exitCode).toBe(0);
    expect(text).toContain('e2e run --step next was not applied: it came before the next pause');
    expect(text).toContain('screen.pause() (tests/pause.e2e.ts:9)');
    expect(await resumed.exited).toBe(0);
    expect(resumed.stdout()).not.toContain('was not applied');

    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
  }, 60_000);

  it('shows pauses from two workers one at a time while a third worker keeps running', async () => {
    const { dir } = project(
      {
        'tests/a.e2e.ts': pausing('first pauser', 1),
        'tests/b.e2e.ts': pausing('second pauser', 1),
        'tests/c.e2e.ts': `import { test } from 'e2e';\n\ntest('never pauses', async ({ app }) => {\n  await new Promise((resolve) => setTimeout(resolve, 2_000));\n  await app.open('/');\n});\n`,
      },
      workerFakeConfigSource(3),
    );
    const run = start(dir, ['run']);
    await run.shows('Paused in');
    await run.shows('never pauses');
    expect(run.stdout().split('Paused in').length - 1).toBe(1);
    const first = run.stdout().includes('Paused in first pauser') ? 'first pauser' : 'second pauser';
    const second = first === 'first pauser' ? 'second pauser' : 'first pauser';

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.exitCode).toBe(0);
    expect(next.stdout).toContain(`Paused in ${second} [fake]:`);

    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toContain('3 passed (3)');
  }, 60_000);

  it('fails a pause while another run in the directory is controlled with e2e run --step, and leaves that run alone', async () => {
    const { dir } = project({
      'tests/pause.e2e.ts': PAUSE_SUITE,
      'tests/pages.e2e.ts': `import { test } from 'e2e';\n\ntest('opens two pages', async ({ app }) => {\n  await app.open('/one');\n  await app.open('/two');\n});\n`,
    });
    expect(e2e(dir, ['run', 'tests/pages.e2e.ts', '--step']).exitCode).toBe(0);

    const paused = e2e(dir, ['run', 'tests/pause.e2e.ts']);
    expect(paused.exitCode).toBe(2);
    expect(paused.stdout).toContain(
      'RUNNER_BUSY: another run in this directory is already controlled with e2e run --step; end it with e2e run --step stop, or run this test in a terminal',
    );
    expect(paused.stdout).toContain('tests/pause.e2e.ts:5');

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.stdout).toContain('✓ app.open "/two"');
  }, 60_000);

  it('pauses the test again once the other run in the directory has ended', async () => {
    const { dir } = project({
      'tests/pages.e2e.ts': `import { test } from 'e2e';\n\ntest('opens two pages', async ({ app }) => {\n  await app.open('/one');\n  await app.open('/two');\n});\n`,
      'tests/pause.e2e.ts': `import { existsSync } from 'node:fs';
import { test } from 'e2e';

test('pauses while busy', async ({ app, screen }) => {
  await app.open('/');
  await screen.pause();
});

test('pauses later', { timeout: 30_000 }, async ({ app, screen }) => {
  console.log('waiting for the other run');
  while (!existsSync(new URL('../go', import.meta.url))) await new Promise((resolve) => setTimeout(resolve, 50));
  await app.open('/');
  await screen.pause();
});
`,
    });
    expect(e2e(dir, ['run', 'tests/pages.e2e.ts', '--step']).exitCode).toBe(0);
    const run = start(dir, ['run', 'tests/pause.e2e.ts']);
    await run.shows('waiting for the other run');

    expect(e2e(dir, ['run', '--step', 'stop']).exitCode).toBe(130);
    writeFileSync(path.join(dir, 'go'), '');
    await run.shows('Paused in pauses later');

    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(2);
    expect(run.stdout()).toContain('RUNNER_BUSY');
    expect(run.stdout()).toContain('1 failed');
    expect(run.stdout()).toContain('1 passed');
  }, 60_000);

  it('pauses a test inside an e2e run --step run, and resumes it on the same commands', () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const started = e2e(dir, ['run', '--step']);
    expect(started.exitCode).toBe(0);
    expect(started.stdout).toMatch(/✓ app\.open "\/one" \d+ms\nPaused in pauses past its timeout \[fake\]:\n {2}screen\.pause\(\) \(tests\/pause\.e2e\.ts:5\)/);

    const next = e2e(dir, ['run', '--step', 'next']);
    expect(next.stdout).toContain('Paused before step 2 of pauses past its timeout [fake]:');

    const last = e2e(dir, ['run', '--step', 'next']);
    expect(last.stdout).toContain('1 passed (1)');
    expect(last.stdout).toMatch(/The stepped run has ended\.\n$/);
  });

  it('stops holding steps on rest in an e2e run --step run, and still pauses at every later screen.pause()', () => {
    const { dir } = project({
      'tests/pause.e2e.ts': `import { test } from 'e2e';

test('steps past two pauses', async ({ app, screen }) => {
  await app.open('/one');
  await app.open('/two');
  await app.open('/three');
  await screen.pause();
  await app.open('/four');
  await screen.pause();
});
`,
    });
    expect(e2e(dir, ['run', '--step']).stdout).toContain('Paused before step 2 of steps past two pauses [fake]:');

    const rest = e2e(dir, ['run', '--step', 'rest']);
    expect(rest.stdout).toMatch(/✓ app\.open "\/two" \d+ms\n✓ app\.open "\/three" \d+ms\nPaused in steps past two pauses \[fake\]:\n {2}screen\.pause\(\) \(tests\/pause\.e2e\.ts:7\)/);
    expect(rest.stdout).toContain('Next: e2e run --step next to resume the test, e2e run --step rest to resume it without holding any more steps, or e2e run --step stop to end the run.');

    const later = e2e(dir, ['run', '--step', 'rest']);
    expect(later.stdout).toMatch(/✓ app\.open "\/four" \d+ms\nPaused in steps past two pauses \[fake\]:\n {2}screen\.pause\(\) \(tests\/pause\.e2e\.ts:9\)/);

    const last = e2e(dir, ['run', '--step', 'next']);
    expect(last.stdout).toContain('1 passed (1)');
    expect(last.stdout).toMatch(/The stepped run has ended\.\n$/);
  }, 60_000);

  it("fails a test that doesn't await its pause with STEP_NOT_AWAITED, and lets the next test pass", () => {
    const { dir } = project({
      'tests/pause.e2e.ts': `import { test } from 'e2e';

test('forgets', async ({ app, screen }) => {
  await app.open('/');
  void screen.pause();
});

test('after', async ({ app }) => {
  await app.open('/');
});
`,
    });
    const startedAt = Date.now();
    const ran = e2e(dir, ['run']);
    // An abandoned pause left visible would take the full 30 s cleanup timeout.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(ran.exitCode, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stdout).toContain('STEP_NOT_AWAITED: the test body returned before screen.pause() finished');
    expect(ran.stdout).toContain('tests/pause.e2e.ts:5');
    expect(ran.stdout).not.toContain('CANCELLED');
    expect(ran.stdout).not.toContain('Paused in');
    expect(ran.stdout).toContain('1 failed');
    expect(ran.stdout).toContain('1 passed');
  }, 60_000);

  it('fails an agent step that calls screen.pause() with ACTION_FAILED, without pausing', () => {
    const { dir } = project(
      {
        'tests/pause.e2e.ts': `import { test } from 'e2e';

test('pauses in a step', async ({ app, agent, screen }) => {
  await app.open('/');
  Object.assign(globalThis, { screenToPause: screen });
  await agent.act('pause');
});
`,
      },
      workerFakeConfigSource(
        1,
        `
  agents: {
    default: {
      executor: {
        name: 'pauses',
        version: '1',
        async runStep() {
          await globalThis.screenToPause.pause();
          return { status: 'passed', summary: 'paused' };
        },
      },
    },
  },`,
      ),
    );
    const ran = e2e(dir, ['run']);
    expect(ran.exitCode, ran.stdout + ran.stderr).toBe(1);
    expect(ran.stdout).toContain('ACTION_FAILED: screen.pause() was called inside another step (an onAction hook or a project tool) or an expect.poll read');
    expect(ran.stdout).not.toContain('Paused in');
  }, 60_000);
});

describe('screen.pause() when the run ends', () => {
  it('answers e2e run --step stop with the end of the run while two tests are paused', async () => {
    const { dir } = project(
      { 'tests/a.e2e.ts': pausingAfterMark('first pauser', 'a-paused'), 'tests/b.e2e.ts': pausingAfterMark('second pauser', 'b-paused') },
      workerFakeConfigSource(2),
    );

    const run = start(dir, ['run']);
    await run.shows('Paused in');
    await marked(dir, 'a-paused', 'b-paused');

    const stopped = e2e(dir, ['run', '--step', 'stop']);
    expect(stopped.stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(130);
    expect(run.stdout().split('Paused in').length - 1).toBe(1);
    expect(existsSync(stepAddress(dir).socket)).toBe(false);
  }, 60_000);

  it('removes the socket file when a third interrupt forces the paused run to exit', async () => {
    // Teardown blocks the worker, so a second interrupt can't finish the run.
    const { dir } = project(
      { 'tests/pause.e2e.ts': `import { test } from 'e2e';\n\ntest.afterEach(() => {\n  const end = Date.now() + 15_000;\n  while (Date.now() < end) {}\n});\n\ntest('pauses before a slow teardown', async ({ app, screen }) => {\n  await app.open('/');\n  await screen.pause();\n});\n` },
      workerFakeConfigSource(1, '\n  cleanupTimeout: 30_000,'),
    );
    const run = await pausedRun(dir);
    expect(existsSync(stepAddress(dir).socket)).toBe(true);

    // Send signals separately. Signals sent together may reach the run as one.
    const child = runs.at(-1)!;
    child.kill('SIGINT');
    await run.shows('interrupt again to force');
    child.kill('SIGINT');
    await run.shows('interrupted again: tearing every worker down now');
    child.kill('SIGINT');
    expect(await run.exited).toBe(130);
    expect(existsSync(stepAddress(dir).socket)).toBe(false);
  }, 60_000);

  it('claims the socket over the file a killed run left, and resumes the test on e2e run --step next', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const { socket } = stepAddress(dir);
    // A process killed while it listens leaves its socket file behind.
    spawnSync(process.execPath, [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
      socket,
    ]);
    expect(existsSync(socket)).toBe(true);

    const run = await pausedRun(dir);
    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    expect(await run.exited).toBe(0);
    expect(existsSync(socket)).toBe(false);
  }, 60_000);
});

describe('screen.pause() in --watch without a terminal', () => {
  it('pauses the test on every run, cancels only that run on stop, and reruns once after a change saved during the pause', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': pausing('pauses in watch', 1) });
    const file = path.join(dir, 'tests', 'pause.e2e.ts');
    const run = start(dir, ['run', '--watch']);
    /** Waits for `text` after the `count`th RERUN banner in the run's output. */
    const shows = async (count: number, text: string): Promise<void> => {
      for (let tries = 0; tries < 600; tries += 1) {
        const banners = run.stdout().split(' RERUN ');

        if (banners.length > count && banners[count]!.includes(text)) {
          return;
        }

        await sleep(50);
      }

      throw new Error(`rerun ${count} never printed ${text}. The run printed:\n${run.stdout()}${run.stderr()}`);
    };
    await shows(0, 'Next: e2e run --step next to resume the test, or e2e run --step stop to end the run.');
    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    await shows(0, 'Waiting for file changes');

    // Save after the first run ends, when the test directory is watched.
    writeFileSync(file, readFileSync(file, 'utf8'));
    await shows(1, 'Paused in pauses in watch [fake]:\n  screen.pause() (tests/pause.e2e.ts:5)');
    writeFileSync(file, readFileSync(file, 'utf8'));
    expect(e2e(dir, ['run', '--step', 'next']).stdout).toBe('The run has ended.\n');
    await shows(2, 'Paused in pauses in watch [fake]:\n  screen.pause() (tests/pause.e2e.ts:5)');
    await shows(1, '1 passed (1)');

    const stopped = e2e(dir, ['run', '--step', 'stop']);
    expect(stopped.stdout).toBe('The run has ended.\n');
    await shows(2, 'run cancelled');
    // Wait for watch mode to be idle again. A rerun started by cancellation
    // would appear first.
    await shows(2, 'Waiting for file changes');
    expect(run.stdout().split(' RERUN ').length - 1).toBe(2);
    expect(e2e(dir, ['run', '--step', 'next']).stderr).toContain('no run in this directory can be controlled with e2e run --step');

    runs.at(-1)!.kill('SIGINT');
    expect(await run.exited).toBe(0);
  }, 90_000);
});

describe('screen.pause() in a terminal', () => {
  it('resumes the test on Enter, and the test passes', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const stdin = fakeStdin();
    const run = terminalRun(dir, stdin);
    await run.shows('paused in pauses past its timeout [fake]: screen.pause() (tests/pause.e2e.ts:5)');
    expect(stdin.setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true]);
    await sleep(KEY_GUARD_MS);

    stdin.write('\r');
    expect((await run.outcome).exitCode).toBe(0);
    expect(run.printed()).toContain('1 passed (1)');
    expect(stdin.setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true, false]);
  }, 60_000);

  it('stops the run on q', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const stdin = fakeStdin();
    const run = terminalRun(dir, stdin);
    await run.shows('paused in pauses past its timeout [fake]');
    await sleep(KEY_GUARD_MS);

    stdin.write('q');
    expect((await run.outcome).exitCode).toBe(130);
    expect(run.printed()).toContain('1 interrupted');
  }, 60_000);

  it("doesn't do anything on n or a at a pause in a run without --step, and resumes on Enter", async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': pausing('pauses twice', 2) });
    const stdin = fakeStdin();
    const run = terminalRun(dir, stdin);
    await run.shows('paused in pauses twice [fake]: screen.pause() (tests/pause.e2e.ts:5)');
    await sleep(KEY_GUARD_MS);

    stdin.write('n');
    stdin.write('a');
    // Check after those keys. If either had resumed the first pause, this
    // command would resume the second and end the run.
    const next = start(dir, ['run', '--step', 'next']);
    await next.shows('Paused in pauses twice [fake]:\n  screen.pause() (tests/pause.e2e.ts:6)');
    expect(await next.exited).toBe(0);
    await sleep(KEY_GUARD_MS);

    stdin.write('\r');
    expect((await run.outcome).exitCode).toBe(0);
  }, 60_000);

  it('answers a command that reaches the run as it ends with the end of the run', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const stdin = fakeStdin();
    const run = terminalRun(dir, stdin);
    await run.shows('paused in pauses past its timeout [fake]');
    // Connect while the test is paused, then send the command after the run ends.
    const late = net.connect(stepAddress(dir).socket);
    await once(late, 'connect');
    await sleep(KEY_GUARD_MS);

    stdin.write('\r');
    expect((await run.outcome).exitCode).toBe(0);
    let answer = '';
    late.setEncoding('utf8');
    late.on('data', (chunk: string) => {
      answer += chunk;
    });
    late.write('{"action":"next"}\n');
    await once(late, 'close');
    expect(JSON.parse(answer)).toEqual({ text: 'The run has ended.\n', exitCode: 0 });
  }, 60_000);

  it('reads the screen at a pause only when a command waits for it', async () => {
    const config = `import { appendFileSync } from 'node:fs';
import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const engine = createFakeEngine({
  state: true,
  observe: () => appendFileSync(new URL('./observed.txt', import.meta.url), 'observe\\n'),
}).engine;

export default {
  targets: [{ name: 'fake', platform: 'fake', engine, app: FAKE_APP }],
  workers: 1,
  timeout: ${TIMEOUT_MS},
} satisfies E2EConfig;
`;
    const { dir } = project({ 'observed.txt': '', 'tests/pause.e2e.ts': pausing('pauses twice', 2) }, config);
    const observed = () => readFileSync(path.join(dir, 'observed.txt'), 'utf8');
    const run = terminalRun(dir, fakeStdin());
    await run.shows('paused in pauses twice [fake]: screen.pause() (tests/pause.e2e.ts:5)');
    expect(observed()).toBe('');

    const next = start(dir, ['run', '--step', 'next']);
    await next.shows('Paused in pauses twice [fake]:\n  screen.pause() (tests/pause.e2e.ts:6)\nScreen:');
    expect(await next.exited).toBe(0);
    expect(observed()).toBe('observe\n');

    const last = start(dir, ['run', '--step', 'next']);
    await last.shows('The run has ended.');
    expect(await last.exited).toBe(0);
    expect((await run.outcome).exitCode).toBe(0);
  }, 60_000);

  it('resumes the test on e2e run --step next from another shell', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const run = terminalRun(dir, fakeStdin());
    await run.shows('paused in pauses past its timeout [fake]');

    // Spawn the command because the paused run answers it in this process.
    const next = start(dir, ['run', '--step', 'next']);
    await next.shows('The run has ended.');
    expect(await next.exited).toBe(0);
    expect((await run.outcome).exitCode).toBe(0);
    expect(run.printed()).toContain('1 passed (1)');
  }, 60_000);

  it('keeps the keys and says so when another run in the directory is controlled with e2e run --step', async () => {
    const { dir } = project({
      'tests/pause.e2e.ts': PAUSE_SUITE,
      'tests/pages.e2e.ts': `import { test } from 'e2e';\n\ntest('opens two pages', async ({ app }) => {\n  await app.open('/one');\n  await app.open('/two');\n});\n`,
    });
    expect(e2e(dir, ['run', 'tests/pages.e2e.ts', '--step']).exitCode).toBe(0);
    const stdin = fakeStdin();
    const output = terminalOutput();
    const interrupt = new AbortController();

    const outcome = servePauses(
      { cwd: dir, env: ENV, files: ['tests/pause.e2e.ts'], interruptSignal: interrupt.signal, processOutput: output.processOutput },
      () => interrupt.abort(),
      stdin,
    );

    inProcess.push({ stop: () => interrupt.abort(), done: outcome.catch(() => undefined) });
    await output.shows('paused in pauses past its timeout [fake]');
    expect(output.printed()).toContain(
      'Another run in this directory is controlled with e2e run --step commands, so use the keys for this run.\n',
    );
    await sleep(KEY_GUARD_MS);

    stdin.write('\r');
    expect((await outcome).exitCode).toBe(0);
  }, 60_000);

  it('keeps the keys and prints why when a lock left by a killed run keeps the commands out', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const { lock } = stepAddress(dir);
    writeFileSync(lock, '');
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lock, stale, stale);
    try {
      const stdin = fakeStdin();
      const run = terminalRun(dir, stdin);
      await run.shows('paused in pauses past its timeout [fake]');
      expect(run.printed()).toContain(
        `RUNNER_BUSY: ${lock} was left by a run killed while it took control of this directory; remove it and run again\nOnly the keys work for this run.\n`,
      );
      await sleep(KEY_GUARD_MS);

      stdin.write('\r');
      expect((await run.outcome).exitCode).toBe(0);
    } finally {
      rmSync(lock, { force: true });
    }
  }, 60_000);

  it('in --watch, reads keys at the pause without cancelling the run, then gives them back to watch', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': pausing('pauses in watch', 1) });
    const stdin = fakeStdin();
    const output = terminalOutput();
    const signals = new SignalLadder();
    const session = watchSession({
      base: { cwd: dir, env: ENV },
      cwd: dir,
      signals,
      run: (options, cancel, keys) =>
        servePauses(
          {
            ...options,
            interruptSignal: AbortSignal.any([signals.interruptSignal, cancel.interruptSignal]),
            forceSignal: cancel.forceSignal,
            processOutput: output.processOutput,
          },
          cancel.stop,
          stdin,
          keys,
        ),
      stdin,
      write: output.write,
      writeError: output.write,
      pc: picocolors.createColors(false),
      clear: false,
      // Test the keys without file changes. On macOS, newly created project
      // files can show up as changes when watch mode starts, which causes an
      // extra rerun.
      watch: () => ({ close: () => undefined, on: () => undefined }),
    });
    // On cleanup, the watch session and its run are ended with one signal, as
    // with Ctrl-C.
    inProcess.push({ stop: () => signals.escalate(), done: session });
    await output.shows('paused in pauses in watch [fake]');
    // The keys are read by watch mode first, then by the pause prompt.
    expect(stdin.setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true, false, true]);
    await sleep(KEY_GUARD_MS);

    // In watch mode, `r` is used to rerun the tests or cancel the current run.
    // At a pause, it's ignored.
    stdin.write('r');
    stdin.write('\r');
    await output.shows('Waiting for file changes');
    expect(output.printed()).toContain('1 passed (1)');
    expect(output.printed()).not.toContain('run cancelled');
    expect(stdin.setRawMode.mock.calls.map(([raw]) => raw)).toEqual([true, false, true, false, true]);

    stdin.write('q');
    await expect(session).resolves.toBe(0);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  }, 60_000);

  it('in --watch, cancels the run on q at the pause and stays in watch', async () => {
    const { dir } = project({ 'tests/pause.e2e.ts': pausing('pauses in watch', 1) });
    const stdin = fakeStdin();
    const output = terminalOutput();
    const signals = new SignalLadder();
    const session = watchSession({
      base: { cwd: dir, env: ENV },
      cwd: dir,
      signals,
      run: (options, cancel, keys) =>
        servePauses(
          {
            ...options,
            interruptSignal: AbortSignal.any([signals.interruptSignal, cancel.interruptSignal]),
            forceSignal: cancel.forceSignal,
            processOutput: output.processOutput,
          },
          cancel.stop,
          stdin,
          keys,
        ),
      stdin,
      write: output.write,
      writeError: output.write,
      pc: picocolors.createColors(false),
      clear: false,
      watch: () => ({ close: () => undefined, on: () => undefined }),
    });
    inProcess.push({ stop: () => signals.escalate(), done: session });
    await output.shows('paused in pauses in watch [fake]');
    await sleep(KEY_GUARD_MS);

    stdin.write('q');
    await output.shows('run cancelled');
    await output.shows('Waiting for file changes');
    expect(output.printed()).toContain('1 interrupted');
    expect(await Promise.race([session, sleep(0, 'watching')])).toBe('watching');

    stdin.write('q');
    await expect(session).resolves.toBe(0);
  }, 60_000);
});

describe('screen.pause() in CI', () => {
  it('fails the test at the pause with PAUSE_UNAVAILABLE, without waiting', () => {
    const { dir } = project({ 'tests/pause.e2e.ts': PAUSE_SUITE });
    const ran = e2e(dir, ['run'], { ...ENV, CI: '1' });
    expect(ran.exitCode).toBe(1);
    expect(ran.stdout).toContain('PAUSE_UNAVAILABLE');
    expect(ran.stdout).toContain('tests/pause.e2e.ts:5');
    expect(ran.stdout).not.toContain('Paused in');
  });
});
