import { readFileSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isRecord } from '@e2e-dev/core/lib/config/command';
import { errorMessage } from '@e2e-dev/core/lib/internal/errors';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Report1Document, ReportResult, ReportSerialGroup, ReportShard } from './build.ts';

export interface ShardInput {
  readonly directory: string;
  readonly document: Report1Document;
  readonly shard: ReportShard;
  readonly repeatEach?: number;
  readonly carriedInterruptions: ReadonlySet<string>;
}

type Run = Report1Document['run'];
type WireResult = Omit<ReportResult, 'agent' | 'repeat' | 'tags' | 'selected'> &
  Partial<Pick<ReportResult, 'agent' | 'repeat' | 'tags' | 'selected'>>;
type WireSerialGroup = Omit<ReportSerialGroup, 'agent' | 'repeat'> &
  Partial<Pick<ReportSerialGroup, 'agent' | 'repeat'>>;
type WireReport = {
  schemaVersion: 'report-1';
  run: Omit<Run, 'finishedAt' | 'results' | 'serialGroups'> & {
    finishedAt?: string;
    results: readonly WireResult[];
    serialGroups: readonly WireSerialGroup[];
  };
};

let validator: ValidateFunction<WireReport> | undefined;

function reportValidator(): ValidateFunction<WireReport> {
  if (validator !== undefined) return validator;
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  const schemaPath = new URL('../../schema/report-v1.schema.json', import.meta.url);
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error('the installed report-1 schema is invalid');
  }
  validator = ajv.compile<WireReport>(schema);
  return validator;
}

function validateReport(contents: unknown): WireReport {
  const validate = reportValidator();
  if (!validate(contents)) {
    const issue = validate.errors?.[0];
    throw new Error(`expected a report-1 document (invalid ${issue?.instancePath || 'envelope'}: ${issue?.keyword ?? 'schema'})`);
  }
  return contents;
}

function readError(file: string, cause: unknown): Error {
  // A JSON parse error can echo bytes from a hand-edited input.
  const detail = cause instanceof SyntaxError ? 'invalid JSON' : errorMessage(cause);
  return new Error(`could not read ${file}: ${detail}`, { cause });
}

async function readReport(file: string): Promise<WireReport> {
  try {
    return validateReport(JSON.parse(await readFile(file, 'utf8')));
  } catch (cause) {
    throw readError(file, cause);
  }
}

async function readHistory(file: string, runId: string): Promise<WireReport | undefined> {
  try {
    const contents: unknown = JSON.parse(await readFile(file, 'utf8'));
    const run = isRecord(contents) && isRecord(contents['run']) ? contents['run'] : undefined;
    const id = run?.['id'];
    if (typeof id === 'string' && id !== runId) return undefined;
    return validateReport(contents);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw readError(file, cause);
  }
}

function normalize(wire: WireReport, finishedAt: string): Report1Document {
  return {
    ...wire,
    run: {
      ...wire.run,
      finishedAt,
      results: wire.run.results.map((row) => ({
        ...row,
        agent: row.agent ?? 'default',
        repeat: row.repeat ?? 0,
        tags: row.tags ?? [],
        selected: row.selected ?? row.skip?.otherShard !== true,
      })),
      serialGroups: wire.run.serialGroups.map((group) => ({
        ...group,
        agent: group.agent ?? 'default',
        repeat: group.repeat ?? 0,
      })),
    },
  };
}

export async function readShard(directory: string): Promise<ShardInput> {
  const real = await realpath(directory);
  const layout = outputLayout(real);
  const raw = await readReport(layout.report);
  const history = await readHistory(layout.withReruns, raw.run.id);
  const chosen = history ?? raw;
  if (chosen === raw && raw.run.carried !== undefined) {
    throw new Error(`${layout.report} has unresolved results and requires its matching report-with-reruns.json`);
  }
  const shard = chosen.run.shard;
  if (chosen.run.finishedAt === undefined) {
    throw new Error(`${layout.report} is unfinished; supply output from a finished shard run`);
  }
  if (chosen.run.explore !== undefined || shard === undefined || shard.index > shard.total) {
    throw new Error(`${layout.report} has no valid shard identity; supply output from e2e run --shard`);
  }
  const document = normalize(chosen, chosen.run.finishedAt);
  // A folded rerun can collapse repeat rows, and an empty shard has no
  // runnable row from which to read its repeat count.
  const repeatEach = history === undefined ? observedRepeatCount(document.run) : undefined;
  const carriedInterruptions = new Set<string>();
  if (history !== undefined) {
    const liveInterruptions = new Set(raw.run.results
      .filter((row) => row.selected !== false && row.status === 'interrupted')
      .map((row) => row.id));
    for (const row of document.run.results) {
      if (row.selected && row.status === 'interrupted' && !liveInterruptions.has(row.id)) carriedInterruptions.add(row.id);
    }
  }
  return { directory: real, document, shard, carriedInterruptions, ...(repeatEach === undefined ? {} : { repeatEach }) };
}

function observedRepeatCount(run: Report1Document['run']): number | undefined {
  const runnable = run.results.filter((row) => row.kind === 'test' && row.selected);
  const repeatEach = runnable.reduce((max, row) => Math.max(max, row.repeat + 1), 1);
  if (repeatEach > 1 || runnable.some((row) => row.attempts.length > 0) || run.serialGroups.some((group) => group.attempts.length > 0)) {
    return repeatEach;
  }
  return undefined;
}
