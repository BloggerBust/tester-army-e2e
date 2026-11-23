/**
 * Records a terminal session as a video for a PR body: what the CLI prints
 * and how it moves, in a real TTY, with the same size and font every time.
 * Drives VHS (https://github.com/charmbracelet/vhs), which must be on PATH.
 *
 * Usage:
 *
 *   node scripts/record-terminal.ts [options] -- <command>
 *   node scripts/record-terminal.ts [options] --tape <file>
 *
 *   --out <file>        the video; .mp4, .webm, or .gif (recording.mp4)
 *   --cwd <dir>         where the command runs (the current directory)
 *   --timeout <s>       how long the command, or the whole tape, may run (120)
 *   --hold <s>          how long the last frame stays (2)
 *   --width <px>        video width (1280)
 *   --height <px>       video height (720)
 *   --font-size <px>    terminal font size (15)
 *   --tape <file>       VHS commands to play instead of one command, for a
 *                       UI that takes keys: Type, Enter, Ctrl+C, Wait+Screen
 *                       /regex/, Sleep
 *
 * The command is typed into bash and the recording ends when the prompt
 * returns, whatever the exit code, so a failure on main records as well as
 * the pass on the branch. Run it once per checkout for a main-vs-branch pair.
 * Several arguments after -- are a program and its arguments; a single one
 * is a shell line ("a && b"). An earlier recording at --out is replaced only
 * when the new one succeeds.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { commandTape, keysTape, shellLine, type TapeOptions } from './record-terminal/tape.ts';

const FORMATS = new Set(['.mp4', '.webm', '.gif']);

function fail(message: string): never {
  process.stderr.write(`record-terminal: ${message}\n`);
  process.exit(2);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', default: 'recording.mp4' },
        cwd: { type: 'string', default: process.cwd() },
        timeout: { type: 'string', default: '120' },
        hold: { type: 'string', default: '2' },
        width: { type: 'string', default: '1280' },
        height: { type: 'string', default: '720' },
        'font-size': { type: 'string', default: '15' },
        tape: { type: 'string' },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

const { values: options, positionals } = parse();

/** A positive integer option, or exit 2 naming it. */
function integer(name: 'timeout' | 'hold' | 'width' | 'height' | 'font-size'): number {
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer`);
  return value;
}

const out = path.resolve(options.out);
if (!FORMATS.has(path.extname(out))) fail(`--out must end in ${[...FORMATS].join(', ')}`);
const cwd = path.resolve(options.cwd);
if (!existsSync(cwd)) fail(`--cwd ${cwd} does not exist`);
if ((options.tape === undefined) === (positionals.length === 0)) fail('pass one of: a command after --, or --tape <file>');

const timeout = integer('timeout');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'record-terminal-'));
const recorded = path.join(scratch, `recording${path.extname(out)}`);
const shared: TapeOptions = {
  out: recorded,
  width: integer('width'),
  height: integer('height'),
  fontSize: integer('font-size'),
  hold: integer('hold'),
};

/** Exit 2 with `message`, leaving no scratch directory and any earlier recording in place. */
function abort(message: string): never {
  rmSync(scratch, { recursive: true, force: true });
  fail(message);
}

function buildTape(): string {
  try {
    return options.tape === undefined
      ? commandTape({ ...shared, command: shellLine(positionals), timeout })
      : keysTape(shared, readFileSync(path.resolve(options.tape), 'utf8'));
  } catch (error) {
    abort(error instanceof Error ? error.message : String(error));
  }
}

const tapeFile = path.join(scratch, 'recording.tape');
writeFileSync(tapeFile, buildTape());

// vhs needs time around the command itself: browser start, typing, the held frame, encoding.
const run = spawnSync('vhs', ['--quiet', tapeFile], {
  cwd,
  stdio: ['ignore', 'inherit', 'pipe'],
  encoding: 'utf8',
  timeout: (timeout + shared.hold + 60) * 1000,
});
if (run.error !== undefined && 'code' in run.error && run.error.code === 'ENOENT') {
  abort('vhs is not on PATH. Install it with `brew install vhs`, or run this under `nix shell nixpkgs#vhs -c`.');
}
if (run.status !== 0 || !existsSync(recorded)) abort(`vhs failed${run.error ? `: ${run.error.message}` : ''}\n${run.stderr}`);

mkdirSync(path.dirname(out), { recursive: true });
copyFileSync(recorded, out);
rmSync(scratch, { recursive: true, force: true });

process.stdout.write(`${out} (${Math.ceil(statSync(out).size / 1024)} kB)\n`);
