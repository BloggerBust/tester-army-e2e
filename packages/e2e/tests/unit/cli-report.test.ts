/** `e2e report` resolution, config isolation, and error handling. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const accessOverride = vi.hoisted(() => ({ fn: undefined as ((target: string) => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: (target: string, mode?: number) => (accessOverride.fn ? accessOverride.fn(target) : actual.access(target, mode)),
  };
});

import { report } from '../../src/cli/report.ts';

let root: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'e2e-report-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  accessOverride.fn = undefined;
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

describe('e2e report', () => {
  it('opens the default .e2e/report.html when no config exists', async () => {
    const file = path.join(root, '.e2e', 'report.html');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<html></html>', 'utf8');
    const opened: string[] = [];

    const code = await report({ cwd: root, open: (url) => opened.push(url) });

    expect(code).toBe(0);
    expect(opened).toEqual([pathToFileURL(file).href]);
    expect(written(stdoutSpy)).toContain(pathToFileURL(file).href);
  });

  it('uses the configured output directory from e2e.config.ts and allows --output to override it', async () => {
    writeFileSync(
      path.join(root, 'e2e.config.ts'),
      "export default { targets: [{ name: 'web', platform: 'web' }], output: 'artifacts/run' };\n",
      'utf8',
    );
    const configured = path.join(root, 'artifacts', 'run', 'report.html');
    const overridden = path.join(root, 'custom-out', 'report.html');
    mkdirSync(path.dirname(configured), { recursive: true });
    mkdirSync(path.dirname(overridden), { recursive: true });
    writeFileSync(configured, '<html></html>', 'utf8');
    writeFileSync(overridden, '<html></html>', 'utf8');

    const openedConfigured: string[] = [];
    expect(await report({ cwd: root, open: (url) => openedConfigured.push(url) })).toBe(0);
    expect(openedConfigured).toEqual([pathToFileURL(configured).href]);

    const openedOverridden: string[] = [];
    expect(await report({ cwd: root, output: 'custom-out', open: (url) => openedOverridden.push(url) })).toBe(0);
    expect(openedOverridden).toEqual([pathToFileURL(overridden).href]);
  });

  it('accepts an explicit file path or directory containing report.html', async () => {
    const customFile = path.join(root, 'custom.html');
    const dirReport = path.join(root, 'bundle', 'report.html');
    writeFileSync(customFile, '<html></html>', 'utf8');
    mkdirSync(path.dirname(dirReport), { recursive: true });
    writeFileSync(dirReport, '<html></html>', 'utf8');

    const opened: string[] = [];
    expect(await report({ cwd: root, path: 'custom.html', open: (url) => opened.push(url) })).toBe(0);
    expect(await report({ cwd: root, path: 'bundle', open: (url) => opened.push(url) })).toBe(0);
    expect(opened).toEqual([pathToFileURL(customFile).href, pathToFileURL(dirReport).href]);
  });

  it('exits 2 when the report file is missing, directory has no report.html, or both [path] and --output are given', async () => {
    const opened: string[] = [];

    expect(await report({ cwd: root, open: (url) => opened.push(url) })).toBe(2);
    expect(written(stderrSpy)).toContain('htmlReporter()');
    expect(written(stderrSpy)).toContain('outputFile');

    const emptyDir = path.join(root, 'empty-dir');
    mkdirSync(emptyDir, { recursive: true });
    expect(await report({ cwd: root, path: 'empty-dir', open: (url) => opened.push(url) })).toBe(2);

    expect(await report({ cwd: root, path: 'a.html', output: 'out', open: (url) => opened.push(url) })).toBe(2);
    expect(written(stderrSpy)).toContain('pass either [path] or --output, not both');
    expect(await report({ cwd: root, output: '   ', open: (url) => opened.push(url) })).toBe(2);
    expect(opened).toEqual([]);
  });

  it('opens an existing report even when e2e.config.ts has missing secrets or incomplete run targets', async () => {
    writeFileSync(
      path.join(root, 'e2e.config.ts'),
      [
        'export default {',
        "  targets: [{ name: 'web', app: { url: 'http://localhost:3000' } }],",
        '  secrets: { PW: process.env.E2E_TEST_DEFINITELY_MISSING_SECRET },',
        "  output: 'artifacts/ci',",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    const file = path.join(root, 'artifacts', 'ci', 'report.html');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<html></html>', 'utf8');
    const opened: string[] = [];

    const code = await report({ cwd: root, open: (url) => opened.push(url) });

    expect(code).toBe(0);
    expect(opened).toEqual([pathToFileURL(file).href]);
  });

  it('exits 2 when report.html exists but is not readable', async () => {
    const file = path.join(root, '.e2e', 'report.html');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '<html></html>', 'utf8');
    accessOverride.fn = async () => {
      const error = new Error(`EACCES: permission denied, access '${file}'`) as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    };
    const opened: string[] = [];

    expect(await report({ cwd: root, open: (url) => opened.push(url) })).toBe(2);
    expect(written(stderrSpy)).toContain('EACCES');
    expect(opened).toEqual([]);
  });
});
