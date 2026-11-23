/**
 * Reporters written every way a project might write one, good and bad, run
 * through the built CLI together: none can change the run's outcome, break
 * another reporter, feed itself, or put anything on stdout but a document.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, type FixtureProject } from '../helpers/run-project.ts';

const CLI = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url));
const LINES = 400;

const TESTS = `import { test } from 'e2e';

console.log('loaded the file');

test('prints a lot', () => {
  for (let line = 0; line < ${LINES}; line += 1) console.log('line ' + line);
  process.stderr.write('half a line');
  process.stderr.write(', finished\\n');
});

test('prints nothing', () => {});

test.skip('is skipped', () => {});
`;

/** A config whose reporters are `reporters`, source text evaluated in the config module. */
const config = (reporters: string): string => `import { appendFileSync, writeFileSync } from 'node:fs';
import { defineEngine } from 'e2e/engine';

const seen = (name) => (event) => appendFileSync(name + '.jsonl', JSON.stringify(event) + '\\n');

/** A reporter as a class: hooks on the prototype, state on the instance. */
class Counting {
  name = 'counting';
  counts = {};
  onEvent(event) {
    this.counts[event.type] = (this.counts[event.type] ?? 0) + 1;
  }
  reportFiles(run) {
    return [{ path: 'counts.json', content: JSON.stringify({ ...this.counts, status: run.status }), label: 'Counts' }];
  }
}

export default {
  targets: [{ name: 'headless', platform: 'test', engine: defineEngine({ name: 'noop', version: '1', spiVersion: 1 }) }],
  workers: 1,
  secrets: { apiToken: 'stress-token-1234' },
  reporters: [${reporters}],
};
`;

/** Reporters that misbehave in each hook, each in its own way. */
const HOSTILE = `
    { name: 'throws-first', onEvent() { throw new Error('first event'); } },
    { name: 'throws-on-output', onEvent(event) { if (event.type === 'output') throw new Error('no output please'); } },
    { name: 'rejects-later', async onEvent(event) { if (event.type === 'test-started') { await null; throw new Error('late rejection'); } } },
    { name: 'throws-a-string', onEvent(event) { if (event.type === 'collected') throw 'not an error'; } },
    { name: 'bad-files', reportFiles() { throw new Error('no files'); } },
    { name: 'junk-files', reportFiles() { return [{ path: 42 }]; } },
    { name: 'clobbers-report', reportFiles(run) { return [{ path: run.reportPath, content: 'clobbered' }]; } },
    { name: 'junk-rows', async onRunFinished() { return [{ label: 'Kept', text: 'yes' }, { label: 'no text' }, 'row']; } },
    { name: 'not-rows', async onRunFinished() { return 'done'; } },
    { name: 'rejects-finish', async onRunFinished() { throw new Error('upload failed'); } },
    { name: 'throws-summary', onSummary() { throw new Error('summary broke'); } },
    {
      name: 'rewrites',
      onEvent(event) {
        if (event.type === 'output') event.text = 'rewritten';
      },
    },
    {
      name: 'retotals',
      onEvent(event) {
        if (event.type === 'collected') event.total = 0;
      },
    },
`;

/** Reporters that print wherever they can, with the secret: none may loop, and none may leak it. */
const CHATTY = `
    { name: 'echo', onEvent(event) { console.log('echo ' + event.type + ' stress-token-1234'); } },
    { name: 'echo-output', onEvent(event) { if (event.type === 'output') process.stderr.write('saw: ' + event.text); } },
    { name: 'echo-later', onEvent(event) { if (event.type === 'output') setTimeout(() => console.log('later stress-token-1234'), 0); } },
    { name: 'echo-finish', async onRunFinished() { console.log('finishing stress-token-1234'); }, onSummary(rows, run) { process.stdout.write('DOCUMENT ' + run.status + ' ' + rows.length + '\\n'); } },
`;

const projects: FixtureProject[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) project.cleanup();
});

function runCli(reporters: string, args: readonly string[] = []) {
  const project = createProject({ 'e2e.config.ts': config(reporters), 'tests/print.e2e.ts': TESTS });
  projects.push(project);
  const cli = spawnSync(process.execPath, [CLI, 'run', ...args], {
    cwd: project.dir,
    env: { ...process.env, CI: '', E2E_TELEMETRY_DISABLED: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(cli.error).toBeUndefined();
  const events = (name: string): Record<string, unknown>[] =>
    readFileSync(path.join(project.dir, `${name}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  return { cli, project, events };
}

describe('reporters of every kind in one run', () => {
  it('runs hostile reporters beside list without changing the outcome, the report, or what a healthy reporter sees', () => {
    // The witness comes last: it sees what every reporter before it left of each event.
    const { cli, project, events } = runCli(`'list', new Counting(),${HOSTILE} { name: 'witness', onEvent: seen('witness') }`);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const report = JSON.parse(readFileSync(path.join(project.dir, '.e2e', 'report.json'), 'utf8')) as { run: { status: string; summary: { passed: number; skipped: number } } };
    expect(report.run).toMatchObject({ status: 'passed', summary: { passed: 2, skipped: 1 } });

    // Each broken hook is one line, naming the reporter and the hook: list shows the live ones, stderr the rest.
    const warnings = `${cli.stdout}\n${cli.stderr}`.split('\n').filter((line) => line.startsWith('e2e: reporter '));
    for (const expected of [
      'e2e: reporter "throws-first" threw on run-started: first event; ignoring it for the rest of the run',
      'e2e: reporter "throws-on-output" threw on output: no output please; ignoring it for the rest of the run',
      'e2e: reporter "rejects-later" threw on test-started: late rejection; ignoring it for the rest of the run',
      'e2e: reporter "throws-a-string" threw on collected: not an error; ignoring it for the rest of the run',
      'e2e: reporter "bad-files" failed: no files',
      'e2e: reporter "junk-files" returned something other than report files; wrote none',
      'e2e: reporter "junk-rows" returned 2 row(s) without a label and text; dropped',
      'e2e: reporter "not-rows" returned something other than summary rows; dropped',
      'e2e: reporter "rejects-finish" failed: upload failed',
      'e2e: reporter "throws-summary" threw in onSummary: summary broke',
    ]) {
      expect(warnings.filter((line) => line === expected), expected).toHaveLength(1);
    }
    expect(warnings.some((line) => line.startsWith('e2e: reporter "clobbers-report" cannot write'))).toBe(true);
    // An event is every reporter's: one that assigns to it is stopped there.
    expect(warnings.some((line) => line.startsWith('e2e: reporter "rewrites" threw on output: '))).toBe(true);
    expect(warnings.some((line) => line.startsWith('e2e: reporter "retotals" threw on collected: '))).toBe(true);
    expect(events('witness').find((event) => event.type === 'collected')).toMatchObject({ total: 3 });

    // The class-based reporter kept its state on `this`, and saw every event.
    const counts = JSON.parse(readFileSync(path.join(project.dir, 'counts.json'), 'utf8')) as Record<string, unknown>;
    expect(counts).toMatchObject({ 'run-started': 1, collected: 1, 'test-started': 2, 'test-finished': 3, 'run-finished': 1, status: 'passed' });

    // list still shows the run and every reporter's rows.
    expect(cli.stdout).toContain('Tests  2 passed | 1 skipped (3)');
    expect(cli.stdout).toMatch(/Counts\s+counts\.json/);
    expect(cli.stdout).toMatch(/Kept\s+yes/);

    // The healthy reporter saw the whole stream in order, every line once, whatever the others did.
    const witnessed = events('witness');
    const seqs = witnessed.map((event) => event.seq as number);
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
    expect(witnessed[0]!.type).toBe('run-started');
    const printed = witnessed.filter((event) => event.type === 'output' && event.pair !== undefined).map((event) => event.text as string).join('');
    expect(printed.split('\n').filter((line) => line.startsWith('line '))).toEqual(Array.from({ length: LINES }, (_, line) => `line ${line}`));
    expect(printed).toContain('half a line, finished\n');
  }, 120_000);

  it('lets reporters print from onEvent, timers, onRunFinished, and onSummary without feeding themselves, leaking a secret, or touching stdout but for a document', () => {
    const { cli, events } = runCli(`'junit', { name: 'witness', onEvent: seen('witness') },${CHATTY}`);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    // Stdout holds the one document a reporter printed from onSummary.
    expect(cli.stdout).toMatch(/^DOCUMENT passed \d+\n$/);
    const output = `${cli.stdout}\n${cli.stderr}`;
    expect(output).not.toContain('stress-token-1234');
    expect(cli.stderr).toContain('finishing <secret:apiToken>');
    expect(cli.stderr).toContain('later <secret:apiToken>');

    // What a reporter printed about an event is output too, but what it printed
    // while handed output never came back: the stream is finite and small.
    const witnessed = events('witness');
    const outputs = witnessed.filter((event) => event.type === 'output').map((event) => event.text as string);
    expect(outputs.some((text) => text.startsWith('saw: '))).toBe(false);
    expect(outputs.some((text) => text.includes('echo output'))).toBe(false);
    expect(outputs.some((text) => text.includes('echo collected <secret:apiToken>'))).toBe(true);
    // Each test line reached the terminal once from the runner and once from the echo.
    const lines = cli.stderr.split('\n');
    expect(lines.filter((line) => line === 'line 7')).toHaveLength(1);
    expect(lines.filter((line) => line === 'saw: line 7')).toHaveLength(1);
  }, 120_000);

  it('takes over from an interactive reporter that breaks mid-run, and loses no output', () => {
    const view = `{
      name: 'view',
      interactive: true,
      onEvent(event) {
        if (event.type !== 'output') return;
        if (event.text === 'line 100\\n') throw new Error('view broke');
        process.stdout.write('VIEW ' + event.text);
      },
    }`;
    const { cli } = runCli(`${view}, { name: 'echo', onEvent(event) { if (event.type === 'test-finished') console.log('echo finished'); } }`);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const shown = cli.stdout.split('\n').filter((line) => line.startsWith('VIEW line ')).map((line) => line.slice('VIEW '.length));
    const taken = cli.stderr.split('\n').filter((line) => line.startsWith('line '));
    // The view showed the first hundred, the runner the rest: every line once, in order.
    expect([...shown, ...taken]).toEqual(Array.from({ length: LINES }, (_, line) => `line ${line}`));
    expect(shown).toHaveLength(100);
    expect(cli.stderr.split('\n').filter((line) => line.includes('"view" threw on output: view broke'))).toHaveLength(1);
    // What another reporter printed after the view broke reaches the terminal too.
    expect(cli.stderr).toContain('echo finished');
  }, 120_000);

  it('refuses two interactive reporters, and an object with only a hook the contract dropped', () => {
    const view = (name: string): string => `{ name: '${name}', interactive: true, onEvent() {} }`;
    const two = runCli(`${view('one')}, ${view('two')}`);
    expect(two.cli.status).toBe(2);
    expect(two.cli.stdout + two.cli.stderr).toContain('reporters "one" and "two" are all interactive');
    // A hook the contract dropped is no hook: the object is not a reporter.
    const dropped = runCli(`{ name: 'hooks', onOutput() {} }`);
    expect(dropped.cli.status).toBe(2);
    expect(dropped.cli.stdout + dropped.cli.stderr).toContain('at least one of onEvent, reportFiles, onRunFinished, and onSummary');
  }, 120_000);

  it('runs fifty reporters at once, each seeing the same stream', () => {
    const many = Array.from({ length: 50 }, (_, index) => `{ name: 'r${index}', onEvent: seen('r${index}'), reportFiles: () => [{ path: 'out/r${index}.txt', content: '${index}' }] }`).join(', ');
    const { cli, project, events } = runCli(`'dot', ${many}`);
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    const first = events('r0').map((event) => `${String(event.seq)}:${String(event.type)}`);
    expect(first.length).toBeGreaterThan(LINES);
    expect(events('r49').map((event) => `${String(event.seq)}:${String(event.type)}`)).toEqual(first);
    expect(readFileSync(path.join(project.dir, 'out', 'r49.txt'), 'utf8')).toBe('49');
  }, 120_000);
});
