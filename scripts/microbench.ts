/**
 * Microbenchmarks of the runner's small pure-JS functions (secret
 * redaction, locator resolution, mobile tree projection), measured as
 * instruction counts under Valgrind so a comparison does not move with the
 * machine's load. Whole suites are `bench:ab`'s job; this measures single
 * functions, without a browser or a device.
 *
 * Usage:
 *
 *   node scripts/microbench.ts [options]
 *
 *   --root <dir>        the checkout to measure, packages built (this one)
 *   --base-root <dir>   also measure this checkout and compare --root against
 *                       it; give both roots paths of the same length
 *   --expect-same       base and head hold the same code: a repeatability
 *                       check (implied when both roots are one directory)
 *   --mode <mode>       jitless, jit, or both (jitless)
 *   --tool <tool>       cachegrind (instructions; Linux with valgrind on PATH)
 *                       or time (wall time; noisy, for local smoke runs)
 *   --trials <n>        trials per case, mode, and checkout (3)
 *   --multiplier <n>    the high run's iterations over the low run's (3)
 *   --threshold <pct>   the noise floor: the smallest change reported as a
 *                       direction (0.5 for cachegrind, 2 for time)
 *   --case <text>       only cases whose name contains this
 *   --jobs <n>          processes at once under cachegrind (available cores);
 *                       always 1 for time
 *   --out <dir>         where result.json and summary.md go
 *   --keep-raw          keep each process's Cachegrind file under <out>/raw
 *
 * Each trial runs a case twice in fresh processes, N and multiplier×N times
 * (N is the case's `iterations`), and keeps the difference over the extra
 * iterations: everything outside the loop cancels. Cases and their inputs
 * come from this checkout and the code under test from each root, so base
 * and head read the same bytes.
 *
 * `jitless`, the default, counts the interpreter only, which also
 * interprets regexps. It is the mode to compare in: in CI, the trials of
 * one commit spread at most 0.17% in every case. `jit` keeps V8's
 * compilers and makes them as deterministic as V8 allows (`--predictable`
 * compiles on the main thread and runs GC single-threaded, plus the seeds,
 * `--single-threaded`, and `--predictable-gc-schedule`), but V8 still makes
 * a different optimization decision in some processes: its trials fall into
 * two clusters up to 2% apart, so use it to look at JIT behavior, not to
 * compare. Either way, counts are not wall time. `--v8-pool-size=0` leaves Node no
 * platform worker threads, and on Linux `setarch -R` turns off address space
 * randomization when the system allows it (the run warns when it does not),
 * so neither moves a count between processes.
 *
 * A root's path is read at startup, and how much it allocates there moves
 * where the collector runs inside the measured loop, so two roots with
 * paths of different lengths can land apart by a fixed offset. The harness
 * warns when they differ.
 *
 * Exits 1 when a repeatability check fails, 2 on a usage or measurement
 * error.
 */

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { renderSummary, repeatabilityFailures, type Mode, type Result, type BenchRow, type SideResult } from './microbench/markdown.ts';
import { assess, cachegrindTotal, slope, spreadOf, type Measurement, type Tool } from './microbench/stats.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CHILD = path.join(import.meta.dirname, 'microbench', 'child.mjs');
const run = promisify(execFile);

const COMMON_FLAGS = [
  '--predictable',
  '--single-threaded',
  '--predictable-gc-schedule',
  '--random-seed=42',
  '--hash-seed=42',
  '--expose-gc',
  '--v8-pool-size=0',
  // Valgrind does not emulate the PKU instructions V8 guards code pages with.
  '--no-memory-protection-keys',
];
const FLAGS: Record<Mode, readonly string[]> = { jit: COMMON_FLAGS, jitless: ['--jitless', ...COMMON_FLAGS] };

const { values: options } = parseArgs({
  options: {
    root: { type: 'string', default: REPO_ROOT },
    'base-root': { type: 'string' },
    mode: { type: 'string', default: 'jitless' },
    tool: { type: 'string' },
    trials: { type: 'string', default: '3' },
    multiplier: { type: 'string', default: '3' },
    'expect-same': { type: 'boolean', default: false },
    threshold: { type: 'string' },
    case: { type: 'string', default: '' },
    jobs: { type: 'string', default: String(os.availableParallelism()) },
    out: { type: 'string' },
    'keep-raw': { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`microbench: ${message}\n`);
  process.exit(2);
}

function log(message: string): void {
  process.stderr.write(`microbench: ${message}\n`);
}

function integer(name: 'trials' | 'multiplier' | 'jobs', min: number): number {
  const value = Number(options[name]);
  if (!Number.isInteger(value) || value < min) fail(`--${name} must be an integer of at least ${min}`);
  return value;
}

function hasValgrind(): boolean {
  return spawnSync('valgrind', ['--version'], { stdio: 'ignore' }).status === 0;
}

/**
 * `setarch <machine> -R` on Linux, the prefix that turns off address space
 * randomization, when it can run a command here. A container can ship
 * `setarch` and still refuse the personality change, which would fail every
 * measured process, so it is tried on `true` first.
 */
const NO_ASLR: readonly string[] =
  process.platform === 'linux' && spawnSync('setarch', [os.machine(), '-R', 'true'], { stdio: 'ignore' }).status === 0
    ? ['setarch', os.machine(), '-R']
    : [];

function shaOf(root: string): string {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

function machine(tool: Tool): string {
  const cpu = os.cpus()[0]?.model.trim() ?? 'unknown CPU';
  const valgrind = tool === 'cachegrind' ? `, ${execFileSync('valgrind', ['--version'], { encoding: 'utf8' }).trim()}` : '';
  const aslr = NO_ASLR.length > 0 ? ', ASLR off' : '';
  return `${os.platform()} ${os.arch()}, ${cpu}, Node ${process.version}${valgrind}${aslr}`;
}

interface CaseInfo {
  readonly name: string;
  readonly iterations: number;
}

/** The cases `child.mjs` defines, filtered by `--case`. */
function listCases(filter: string): CaseInfo[] {
  const all = JSON.parse(execFileSync(process.execPath, [CHILD, '--list'], { encoding: 'utf8' })) as CaseInfo[];
  const selected = all.filter((entry) => entry.name.includes(filter));
  if (selected.length === 0) fail(`--case ${JSON.stringify(filter)} matches none of: ${all.map((entry) => entry.name).join(', ')}`);
  return selected;
}

/**
 * A fixed, small environment, the same for every process: what the
 * environment holds is read at startup, and a thread pool of one keeps
 * libuv's workers from interleaving differently between runs.
 */
const CHILD_ENV: NodeJS.ProcessEnv = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: os.homedir(),
  LANG: 'C',
  TZ: 'UTC',
  UV_THREADPOOL_SIZE: '1',
};

/** One process of one case, `iterations` times: its instruction count, or the loop's nanoseconds. */
async function measureOnce(tool: Tool, root: string, name: string, mode: Mode, iterations: number, rawFile: string): Promise<Measurement> {
  const node = [process.execPath, ...FLAGS[mode], CHILD, root, name, String(iterations)];
  const [command, ...args] = [
    ...NO_ASLR,
    ...(tool === 'cachegrind'
      ? ['valgrind', '-q', '--tool=cachegrind', '--cache-sim=no', '--smc-check=all-non-file', `--cachegrind-out-file=${rawFile}`]
      : []),
    ...node,
  ];
  let stdout: string;
  try {
    ({ stdout } = await run(command as string, args, { env: CHILD_ENV, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    const output = error as { stderr?: string; message: string };
    throw new Error(`${name} (${mode}, ${iterations} iterations, ${root}) failed: ${(output.stderr ?? output.message).slice(-4000)}`, { cause: error });
  }
  const { ns } = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as { ns?: number };
  if (typeof ns !== 'number') throw new Error(`${name} (${mode}) printed no result: ${stdout.slice(-1000)}`);
  if (tool === 'time') return { iterations, total: ns };
  const total = cachegrindTotal(readFileSync(rawFile, 'utf8'));
  // A file holds a count for every symbol of the node binary: megabytes, and only the total is read.
  if (!options['keep-raw']) rmSync(rawFile);
  return { iterations, total };
}

/** Runs `tasks` with at most `jobs` at once, in order when `jobs` is 1. */
async function pool(tasks: readonly (() => Promise<void>)[], jobs: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next] as () => Promise<void>;
      next += 1;
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
}

async function main(): Promise<void> {
  const tool = (options.tool ?? (hasValgrind() ? 'cachegrind' : undefined)) as Tool | undefined;
  if (tool === undefined) fail('valgrind is not on PATH; install it (Linux only), or pass --tool time for noisy wall time');
  if (tool !== 'cachegrind' && tool !== 'time') fail('--tool must be cachegrind or time');
  if (tool === 'cachegrind' && !hasValgrind()) fail('--tool cachegrind needs valgrind on PATH');
  const modes: Mode[] = options.mode === 'both' ? ['jit', 'jitless'] : options.mode === 'jit' || options.mode === 'jitless' ? [options.mode] : fail('--mode must be jitless, jit, or both');
  const trials = integer('trials', 1);
  const multiplier = integer('multiplier', 2);
  const jobs = tool === 'time' ? 1 : integer('jobs', 1);
  const thresholdPercent = Number(options.threshold ?? (tool === 'cachegrind' ? '0.5' : '2'));
  if (!(thresholdPercent >= 0)) fail('--threshold must be a non-negative number');

  const headRoot = realpathSync(options.root);
  const baseRoot = options['base-root'] === undefined ? undefined : realpathSync(options['base-root']);
  const sides = baseRoot === undefined ? (['head'] as const) : (['base', 'head'] as const);
  const roots = { base: baseRoot ?? headRoot, head: headRoot };
  if (options['expect-same'] && baseRoot === undefined) fail('--expect-same needs --base-root');
  const expectSame = options['expect-same'] || baseRoot === headRoot;
  if (roots.base.length !== roots.head.length) {
    log(`warning: the roots' paths differ in length (${roots.base.length} and ${roots.head.length}); a fixed offset between them can show up as a change`);
  }
  const cases = listCases(options.case);
  const out = path.resolve(options.out ?? path.join(os.tmpdir(), 'e2e-microbench', new Date().toISOString().replaceAll(':', '-')));
  mkdirSync(out, { recursive: true });
  if (process.platform === 'linux' && NO_ASLR.length === 0) {
    log('warning: setarch -R cannot run here, so address space randomization stays on and counts may vary more between processes');
  }
  log(`${tool}, ${modes.join(' and ')}, ${cases.length} case(s), ${trials} trial(s), ${jobs} job(s); writing ${out}`);

  // perIteration[mode][case][side][trial]
  const perIteration = new Map<string, number[]>();
  const key = (mode: Mode, name: string, side: string): string => `${mode}\0${name}\0${side}`;
  const tasks: (() => Promise<void>)[] = [];
  for (const mode of modes) {
    for (let trial = 0; trial < trials; trial += 1) {
      for (const [index, benchCase] of cases.entries()) {
        // Alternate which side runs first, by round and by case, so neither always runs on a warmer machine.
        const order = (trial + index) % 2 === 0 ? sides : sides.toReversed();
        for (const side of order) {
          tasks.push(async () => {
            const dir = path.join(out, 'raw', mode, side, benchCase.name.replaceAll('/', '_'));
            mkdirSync(dir, { recursive: true });
            const low = await measureOnce(tool, roots[side], benchCase.name, mode, benchCase.iterations, path.join(dir, `${trial}-low.out`));
            const high = await measureOnce(tool, roots[side], benchCase.name, mode, benchCase.iterations * multiplier, path.join(dir, `${trial}-high.out`));
            const values = perIteration.get(key(mode, benchCase.name, side)) ?? [];
            values[trial] = slope(low, high);
            perIteration.set(key(mode, benchCase.name, side), values);
            log(`${mode} ${benchCase.name} ${side} trial ${trial + 1}/${trials}: ${values[trial]?.toFixed(1)}`);
          });
        }
      }
    }
  }
  await pool(tasks, jobs);

  const shas = { base: shaOf(roots.base), head: shaOf(roots.head) };
  const sideResult = (mode: Mode, name: string, side: 'base' | 'head'): SideResult => {
    const values = perIteration.get(key(mode, name, side)) ?? [];
    return { sha: shas[side], perIteration: values, spread: spreadOf(values) };
  };
  const rows: BenchRow[] = modes.flatMap((mode) =>
    cases.map((benchCase): BenchRow => {
      const head = sideResult(mode, benchCase.name, 'head');
      if (baseRoot === undefined) return { case: benchCase.name, mode, head };
      const base = sideResult(mode, benchCase.name, 'base');
      return { case: benchCase.name, mode, head, base, assessment: assess(tool, base.perIteration, head.perIteration, thresholdPercent) };
    }),
  );
  const result: Result = {
    tool,
    trials,
    multiplier,
    thresholdPercent,
    expectSame,
    flags: FLAGS,
    machine: machine(tool),
    rows,
  };
  const summary = renderSummary(result);
  writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(path.join(out, 'summary.md'), summary);
  if (process.env['GITHUB_STEP_SUMMARY'] !== undefined) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
  process.stdout.write(summary);
  const failures = repeatabilityFailures(result);
  if (failures.length > 0) {
    log(`repeatability check failed: ${failures.map((row) => `${row.case} (${row.mode})`).join(', ')}`);
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
