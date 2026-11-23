import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DotProgress } from '../../src/report/dot.ts';
import type { OutputStream } from '../../src/run/process-output.ts';

function capture() {
  const text = { stdout: '', stderr: '' };
  return {
    text,
    write: (stream: OutputStream, chunk: string) => {
      text[stream] += chunk;
    },
  };
}

describe('dot progress output', () => {
  it.each(['stdout', 'stderr'] as const)('ends unfinished user %s before returning the terminal', (stream) => {
    const output = capture();
    const reporter = new DotProgress('stdout', output.write, false);

    reporter.show(stream, 'tail');
    reporter.settle();

    expect(output.text[stream]).toBe('tail\n');
    expect(output.text[stream === 'stdout' ? 'stderr' : 'stdout']).toBe('');
  });

  it('tracks unfinished text separately for each destination', () => {
    const output = capture();
    const reporter = new DotProgress('stdout', output.write, false);

    reporter.show('stdout', 'stdout tail');
    reporter.show('stderr', 'stderr tail');
    reporter.show('stdout', '\n');
    reporter.settle();

    expect(output.text).toEqual({ stdout: 'stdout tail\n', stderr: 'stderr tail\n' });
  });

  it('closes the shared stderr destination only once when stdout is reserved for JSON', () => {
    const output = capture();
    const reporter = new DotProgress('stderr', output.write, false);

    reporter.show('stdout', 'stdout tail');
    reporter.show('stderr', 'stderr tail');
    reporter.settle();

    expect(output.text).toEqual({ stdout: '', stderr: 'stdout tailstderr tail\n' });
  });

  it('ignores empty output without breaking a progress row', () => {
    const output = capture();
    const reporter = new DotProgress('stdout', output.write, false);

    reporter.finished('passed');
    reporter.show('stdout', '');
    reporter.show('stderr', '');
    reporter.finished('passed');
    reporter.settle();

    expect(output.text).toEqual({ stdout: '..\n', stderr: '' });
  });

  it('does not add blank lines to completed user output or repeated settle calls', () => {
    const output = capture();
    const reporter = new DotProgress('stdout', output.write, false);

    reporter.show('stdout', 'complete\n');
    reporter.show('stderr', 'tail');
    reporter.settle();
    reporter.settle();

    expect(output.text).toEqual({ stdout: 'complete\n', stderr: 'tail\n' });
  });

  it('starts marks on a fresh line after unfinished user stdout', () => {
    const output = capture();
    const reporter = new DotProgress('stdout', output.write, false);

    reporter.show('stdout', 'tail');
    reporter.finished('passed');
    reporter.settle();

    expect(output.text).toEqual({ stdout: 'tail\n.\n', stderr: '' });
  });

  it('prints the final mark for each result status', () => {
    const output = capture();
    const dots = new DotProgress('stdout', output.write, false);

    for (const status of ['passed', 'flaky', 'failed', 'timed-out', 'interrupted', 'skipped'] as const) dots.finished(status);
    dots.settle();

    expect(output.text).toEqual({ stdout: '.~FTI-\n', stderr: '' });
  });

  it.each([false, true])('wraps 2,000 marks at 80 visible columns, colors=%s', (colors) => {
    const output = capture();
    const dots = new DotProgress('stdout', output.write, colors);

    for (let index = 0; index < 2_000; index++) dots.finished('passed');
    dots.settle();

    expect(stripVTControlCharacters(output.text.stdout)).toBe(`${Array.from({ length: 25 }, () => '.'.repeat(80)).join('\n')}\n`);
    expect(output.text.stderr).toBe('');
  });

  it('starts a new progress row after user output interrupts it', () => {
    const output = capture();
    const dots = new DotProgress('stdout', output.write, false);

    for (let index = 0; index < 79; index++) dots.finished('passed');
    dots.show('stdout', 'user output\n');
    dots.finished('passed');
    dots.finished('failed');
    dots.settle();

    expect(output.text.stdout).toBe(`${'.'.repeat(79)}\nuser output\n.F\n`);
  });

  it('colors pass, flaky, failure, and skipped marks when colors are enabled', () => {
    const output = capture();
    const dots = new DotProgress('stdout', output.write, true);

    for (const status of ['passed', 'flaky', 'failed', 'skipped'] as const) dots.finished(status);
    dots.settle();

    expect(stripVTControlCharacters(output.text.stdout)).toBe('.~F-\n');
    expect(output.text.stdout).toContain('\u001b[32m.');
    expect(output.text.stdout).toContain('\u001b[33m~');
    expect(output.text.stdout).toContain('\u001b[31mF');
    expect(output.text.stdout).toContain('\u001b[90m-');
  });
});
