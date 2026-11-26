import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { isStrictlyInside } from '@e2e-dev/core/lib/internal/paths';
import { outputLayout } from '@e2e-dev/core/lib/run/output';
import type { Report1Document, ReportAttempt, ReportSerialAttempt } from './build.ts';
import type { ShardInput } from './merge-input.ts';

function shardPrefix(shard: number): string {
  return `shard-${shard}/`;
}

export function mergedAttempt<Attempt extends ReportAttempt | ReportSerialAttempt>(attempt: Attempt, shard: number): Attempt {
  const artifacts = attempt.artifacts.map((artifact) => {
    const relative = artifact.path;
    if (relative === undefined) return artifact;
    // The wire schema alone does not guarantee that the string is a portable,
    // relative filesystem path. Check its components before copying it.
    if (/^[A-Za-z]:/u.test(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error(`invalid local artifact path in shard ${shard}`);
    }
    return { ...artifact, path: shardPrefix(shard) + relative };
  });
  return { ...attempt, shard, artifacts };
}

/** Copy and verify only local files named by retained attempts. */
export async function copyMergedArtifacts(report: Report1Document, inputs: readonly ShardInput[], destination: string): Promise<void> {
  const roots = new Map(inputs.map(({ directory, shard }) => [shard.index, outputLayout(directory).results]));
  const copied = new Map<string, { size: number; sha256: string }>();

  async function copy(attempt: ReportAttempt | ReportSerialAttempt): Promise<void> {
    const shard = attempt.shard;
    const root = shard === undefined ? undefined : roots.get(shard);
    if (shard === undefined || root === undefined) throw new Error('merged attempt has no input shard');
    const prefix = shardPrefix(shard);
    for (const artifact of attempt.artifacts) {
      const merged = artifact.path;
      if (merged === undefined) continue;
      const relative = merged.slice(prefix.length);
      let bytes = copied.get(merged);
      if (bytes === undefined) {
        const from = await realpath(path.join(root, relative)).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== 'ENOENT') throw cause;
          throw new Error(`artifact "${relative}" is missing from shard ${shard}; download the entire shard output`, { cause });
        });
        if (!isStrictlyInside(root, from) || !(await stat(from)).isFile()) {
          throw new Error(`artifact in shard ${shard} must be a file inside its results directory`);
        }
        const to = path.join(destination, merged);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(from, to);
        // Verify the staged bytes, the same file the reporters will receive.
        const digest = createHash('sha256');
        await pipeline(createReadStream(to), digest);
        bytes = { size: (await stat(to)).size, sha256: digest.digest('hex') };
        copied.set(merged, bytes);
      }
      if ((artifact.size !== undefined && artifact.size !== bytes.size) ||
          (artifact.sha256 !== undefined && artifact.sha256 !== bytes.sha256)) {
        throw new Error(`artifact "${relative}" in shard ${shard} does not match its recorded size or digest`);
      }
    }
  }

  for (const group of report.run.serialGroups) for (const attempt of group.attempts) await copy(attempt);
  for (const result of report.run.results) for (const attempt of result.attempts) await copy(attempt);
}
