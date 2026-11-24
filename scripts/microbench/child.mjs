/**
 * One measured process of `scripts/microbench.ts`.
 *
 *   node <flags> scripts/microbench/child.mjs <root> <case> <iterations>
 *   node scripts/microbench/child.mjs --list
 *
 * Loads the case from `root`, runs its warmup loop, checks the result, forces
 * a collection, then runs the measured loop `iterations` times and prints
 * `{"ns": <wall time of the loop>}`. Under Valgrind the whole process is
 * counted; the parent runs two iteration counts and keeps the difference, so
 * startup, loading, warmup, and compilation cancel out.
 *
 * Plain JavaScript, because `--jitless` turns off WebAssembly and Node's
 * TypeScript stripping needs it.
 */

import { CASES } from './cases.mjs';

const [first, name, count] = process.argv.slice(2);

if (first === '--list') {
  process.stdout.write(`${JSON.stringify(CASES.map((entry) => ({ name: entry.name, description: entry.description, iterations: entry.iterations })))}\n`);
} else {
  const benchCase = CASES.find((entry) => entry.name === name);
  const iterations = Number(count);
  if (first === undefined || benchCase === undefined || !Number.isInteger(iterations) || iterations < 1) {
    process.stderr.write('usage: child.mjs <root> <case> <iterations> | child.mjs --list\n');
    process.exit(2);
  }
  const workload = await benchCase.load(first);
  let result;
  for (let i = 0; i < benchCase.warmup; i += 1) result = workload.run();
  workload.check(result);
  result = undefined;
  globalThis.gc?.();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) result = workload.run();
  const ns = Number(process.hrtime.bigint() - start);
  workload.check(result);
  process.stdout.write(`${JSON.stringify({ ns })}\n`);
}
