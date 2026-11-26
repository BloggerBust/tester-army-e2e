import { combineExitCodes } from '@e2e-dev/core/lib/internal/errors';
import { isLoopbackAddress } from '@e2e-dev/core/lib/internal/urls';
import { uuidv7 } from '@e2e-dev/core/lib/internal/ids';
import { compareTests, statusOf, type Report1Document, type ReportMerge, type ReportMergeShard, type ReportResult, type ReportSerialGroup } from './build.ts';
import { combineReportUsage, runDuration, testKey } from './fold.ts';
import { mergedAttempt } from './merge-artifacts.ts';
import type { ShardInput } from './merge-input.ts';
import { summarizeResults } from './summary.ts';

type Run = Report1Document['run'];
type Target = Run['targets'][number];
type ShardRows = { readonly input: ShardInput; readonly rows: ReportResult[] };
type Merge = { readonly report: Report1Document; readonly warnings: readonly string[] };

function assertUniqueIds(rows: readonly { readonly id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`${label} ${row.id}`);
    ids.add(row.id);
  }
}

function append<Key, Value>(index: Map<Key, Value[]>, key: Key, value: Value): void {
  const existing = index.get(key);
  if (existing === undefined) index.set(key, [value]);
  else existing.push(value);
}

type ShardSetup = { readonly input: ShardInput; readonly row: ReportResult };

const SETUP_VERDICTS: readonly ReportResult['status'][] = ['passed', 'flaky', 'skipped', 'interrupted', 'timed-out', 'failed'];

function mergeSetups(setups: ReadonlyMap<string, readonly ShardSetup[]>): ReportResult[] {
  return [...setups.values()].map((runs) => {
    const selected = runs.filter(({ row }) => row.selected);
    const owners = selected.length > 0 ? selected : runs.slice(0, 1);
    const worst = owners.map(({ row }) => row).reduce((a, b) =>
      SETUP_VERDICTS.indexOf(a.status) >= SETUP_VERDICTS.indexOf(b.status) ? a : b,
    );
    const attempts = owners.flatMap(({ input, row }) =>
      row.attempts.map((attempt) => mergedAttempt(attempt, input.shard.index)),
    ).map((attempt, index) => ({ ...attempt, index }));
    return { ...worst, attempts };
  });
}

function selection({ rows }: ShardRows): 'owner' | 'other-shard' | 'filtered-out' {
  if (rows.every((row) => row.skip?.otherShard === true)) return 'other-shard';
  if (rows.every((row) => row.selected === false && row.skip?.otherShard !== true && row.skip?.filter === undefined)) {
    return 'filtered-out';
  }
  return 'owner';
}

function owner(candidates: readonly ShardRows[], key: string): ShardRows {
  const states = candidates.map((candidate) => ({ candidate, state: selection(candidate) }));
  if (states.every(({ state }) => state === 'filtered-out')) return candidates[0]!;
  const owning = states.filter(({ state }) => state !== 'other-shard');
  if (owning.length === 1 && owning[0]?.state === 'owner') return owning[0].candidate;
  const detail = states.map(({ candidate, state }) => `shard ${candidate.input.shard.index}: ${state}`).join(', ');
  throw new Error(`incompatible shard selection for ${key}: expected one owning shard (${detail})`);
}

function checkCoverage(inputs: readonly ShardInput[]): void {
  const first = inputs[0]!;
  const runIds = new Set<string>();
  for (const [position, input] of inputs.entries()) {
    if (input.shard.total !== first.shard.total) throw new Error('shard totals disagree');
    if (input.shard.index === inputs[position - 1]?.shard.index) throw new Error(`duplicate shard ${input.shard.index}`);
    if (runIds.has(input.document.run.id)) throw new Error(`shard ${input.shard.index} repeats another shard's run id`);
    runIds.add(input.document.run.id);
  }
  // Report the first gap without walking a potentially large declared total.
  const gap = inputs.findIndex((input, index) => input.shard.index !== index + 1);
  if (gap !== -1 || inputs.length !== first.shard.total) {
    const missing = gap === -1 ? inputs.length + 1 : gap + 1;
    throw new Error(`missing shard ${missing} of ${first.shard.total}; download the output of every shard from this CI run`);
  }
}

function sameOrigin(first: string | undefined, other: string | undefined, sameConfig: boolean): boolean {
  if (first === other) return true;
  if (!sameConfig || first === undefined || other === undefined) return false;
  // The digest includes the declared app URL. Only the assigned port can
  // differ between shards with matching declarations on a literal loopback.
  const a = URL.parse(first);
  const b = URL.parse(other);
  return a !== null && b !== null && a.origin === first && b.origin === other &&
    isLoopbackAddress(a.hostname) && a.hostname === b.hostname && a.protocol === b.protocol;
}

function engineIdentity(target: Target): string {
  const { name, version, spiVersion } = target.engine;
  return JSON.stringify([name, version, spiVersion, target.capabilities.toSorted(), target.artifactCapabilities.toSorted(), target.stateCapability]);
}

function checkRun(first: Run, other: Run, index: number, warnings: string[]): void {
  if (other.project.id !== first.project.id) throw new Error(`shard ${index} has a different project id`);
  if (other.runner.version !== first.runner.version) throw new Error(`shard ${index} has a different runner version`);
  const firstTargets = new Map(first.targets.map((target) => [target.id, target]));
  const sameConfig = first.project.configDigest === other.project.configDigest;
  if (first.targets.length !== other.targets.length) throw new Error(`shard ${index} has different targets`);
  for (const target of other.targets) {
    const original = firstTargets.get(target.id);
    if (original === undefined || original.platform !== target.platform || original.environment !== target.environment ||
        !sameOrigin(original.baseOrigin, target.baseOrigin, sameConfig)) {
      throw new Error(`shard ${index} has different targets`);
    }
    firstTargets.delete(target.id);
    if (engineIdentity(original) !== engineIdentity(target)) {
      warnings.push(`shard ${index} has different engine metadata for target "${target.id}"`);
    }
  }
  if (!sameConfig) warnings.push(`shard ${index} has a different config digest`);
}

function checkShardRows(inputs: readonly ShardInput[]): void {
  const setupAgents = new Map<string, string>();
  for (const input of inputs) {
    assertUniqueIds(input.document.run.serialGroups, `shard ${input.shard.index} repeats serial group id`);
    assertUniqueIds(input.document.run.results, `shard ${input.shard.index} repeats result id`);
    for (const row of input.document.run.results) {
      if (row.kind !== 'setup') continue;
      const key = JSON.stringify([row.testId, row.targetId]);
      const agent = setupAgents.get(key);
      if (agent !== undefined && agent !== row.agent) throw new Error(`incompatible setup agents for ${key}`);
      setupAgents.set(key, row.agent);
    }
  }
}

function mergeTests(
  inputs: readonly ShardInput[],
  tests: ReadonlyMap<string, readonly ShardRows[]>,
): { results: ReportResult[]; serialGroups: ReportSerialGroup[] } {
  const groups = new Map(inputs.map((input) => [input, new Map(input.document.run.serialGroups.map((group) => [group.id, group]))]));
  const results: ReportResult[] = [];
  const serialGroups = new Map<string, { group: ReportSerialGroup; shard: number }>();
  for (const [key, candidates] of tests) {
    if (candidates.length !== inputs.length) throw new Error(`incompatible shard selection: ${key} is absent from one or more shards`);
    const owned = owner(candidates, key);
    for (const row of owned.rows) {
      if (row.skip?.otherShard === true) continue;
      const groupId = row.serialGroupId;
      if (groupId !== undefined) {
        const group = groups.get(owned.input)?.get(groupId);
        if (group === undefined) throw new Error(`shard ${owned.input.shard.index} is missing serial group ${groupId}`);
        const existing = serialGroups.get(groupId);
        if (existing !== undefined && existing.group !== group) throw new Error(`serial group ${groupId} spans shards`);
        serialGroups.set(groupId, { group, shard: owned.input.shard.index });
      }
      const shard = owned.input.shard.index;
      results.push({
        ...row,
        ...(row.selected || row.skip?.filter !== undefined ? { shard } : {}),
        attempts: row.attempts.map((attempt) => mergedAttempt(attempt, shard)),
      });
    }
  }
  return {
    results,
    serialGroups: [...serialGroups.values()].map(({ group, shard }) => ({
      ...group,
      attempts: group.attempts.map((attempt) => mergedAttempt(attempt, shard)),
    })),
  };
}

function mergeResults(inputs: readonly ShardInput[]) {
  checkShardRows(inputs);
  const setups = new Map<string, ShardSetup[]>();
  const tests = new Map<string, ShardRows[]>();
  for (const input of inputs) {
    const rows = new Map<string, ReportResult[]>();
    for (const row of input.document.run.results) {
      if (row.kind === 'setup') append(setups, JSON.stringify([testKey(row), row.id]), { input, row });
      else append(rows, testKey(row), row);
    }
    for (const [key, owned] of rows) append(tests, key, { input, rows: owned });
  }
  const { results, serialGroups } = mergeTests(inputs, tests);
  return { results: [...mergeSetups(setups), ...results], serialGroups };
}

function mergedStatus(exitCode: Run['exitCode'], runs: readonly Run[], hasRunErrors: boolean): Run['status'] {
  // The shard builders already examined their setup and test failures. A merge
  // remains blocked only when every non-passing shard was itself blocked.
  const nonPassing = runs.filter((run) => run.exitCode !== 0);
  if (exitCode === 1 && !hasRunErrors && nonPassing.length > 0 && nonPassing.every((run) => run.status === 'blocked')) {
    return 'blocked';
  }
  return statusOf(exitCode);
}

export function mergeShardReports(shards: readonly ShardInput[]): Merge {
  const inputs = shards.toSorted((a, b) => a.shard.index - b.shard.index);
  checkCoverage(inputs);
  const repeatCounts = new Set(inputs.flatMap((input) => input.repeatEach === undefined ? [] : [input.repeatEach]));
  if (repeatCounts.size > 1) throw new Error('shards used different repeat counts; use the same --repeat-each for each shard');
  const first = inputs[0]!.document.run;
  const warnings: string[] = [];
  const vcs = inputs.find((input) => input.document.run.vcs?.commit !== undefined)?.document.run.vcs ?? first.vcs;
  for (const { shard, document: { run } } of inputs) {
    if (run.vcs?.commit !== undefined && vcs?.commit !== run.vcs.commit) {
      throw new Error(`shard ${shard.index} has a different commit`);
    }
    if (run.vcs?.commit === undefined && vcs?.commit !== undefined) {
      warnings.push(`shard ${shard.index} did not record a commit`);
    }
    if (run === first) continue;
    checkRun(first, run, shard.index, warnings);
  }
  const { results, serialGroups } = mergeResults(inputs);
  assertUniqueIds(results, 'merged report repeats result id');
  const targetOrder = new Map(first.targets.map((target, index) => [target.id, index]));
  results.sort((a, b) =>
    compareTests(a, b) || (targetOrder.get(a.targetId) ?? 0) - (targetOrder.get(b.targetId) ?? 0) || a.repeat - b.repeat,
  );
  const runs = inputs.map((input) => input.document.run);
  const summary = summarizeResults(results, serialGroups);
  const errors = runs.flatMap((run) => run.errors);
  // Fresh shards already report why they stopped. Only a folded shard
  // can bring back an interrupted verdict from an earlier invocation.
  const interruptions = new Map(inputs.map((input) => [input.shard.index, input.carriedInterruptions]));
  const interruptedHistory = results.some((row) => {
    if (!row.selected || row.status !== 'interrupted') return false;
    if (row.shard !== undefined) return interruptions.get(row.shard)?.has(row.id) === true;
    return inputs.some((input) => input.carriedInterruptions.has(row.id));
  });
  const resultExitCode = interruptedHistory ? 130 : summary.failed > 0 ? 1 : 0;
  const exitCode = combineExitCodes([...runs.map((run) => run.exitCode), resultExitCode]);
  const status = mergedStatus(exitCode, runs, errors.length > 0);
  const usage = runs.slice(1).reduce((total, run) => combineReportUsage(total, run.usage, results.length), { ...first.usage, discoveredResults: results.length });
  const times = runs.map((run) => [run.startedAt, run.finishedAt] as const);
  const startedAt = times.map(([start]) => start).toSorted()[0]!;
  const finishedAt = times.map(([, finish]) => finish).toSorted().at(-1)!;
  const merge: ReportMerge = {
    shardDurationMs: runs.reduce((sum, run) => sum + Math.max(0, runDuration(run)), 0),
    shards: inputs.map(({ shard: { index }, document: { run } }): ReportMergeShard => ({
      index,
      id: run.id,
      status: run.status,
      exitCode: run.exitCode,
      configDigest: run.project.configDigest,
      ...(run.changes === undefined ? {} : { changes: run.changes }),
      ...(run.filters === undefined ? {} : { filters: run.filters }),
    })),
  };
  return {
    warnings,
    report: {
      schemaVersion: 'report-1',
      run: {
        id: uuidv7(),
        specVersion: first.specVersion,
        runner: first.runner,
        project: first.project,
        environment: first.environment,
        ...(vcs === undefined ? {} : { vcs }),
        merge,
        startedAt,
        finishedAt,
        durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        status,
        exitCode,
        targets: first.targets,
        limits: first.limits,
        results,
        serialGroups,
        errors,
        summary,
        usage,
      },
    },
  };
}
