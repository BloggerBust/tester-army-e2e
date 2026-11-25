/**
 * Posts the `microbench` workflow's results to its pull request as one
 * comment, and edits that comment on every later run
 * (`.github/workflows/microbench.yml`, job `comment`).
 *
 *   node scripts/microbench/post-comment.ts <dir> [--dry-run]
 *
 * `<dir>` holds the downloaded artifacts, `microbench-compare/result.json`
 * and `microbench-repeatability/result.json`; a job that did not finish, or
 * whose download failed, leaves its file out, and the comment says so. Reads the pull request number
 * and head from the event at `GITHUB_EVENT_PATH` and posts with
 * `GITHUB_TOKEN` against `GITHUB_REPOSITORY`. A rerun of a run whose head the
 * pull request has moved past posts nothing, so it cannot replace the current
 * head's results. `--dry-run` prints the comment and posts nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { graphql, setMarkerComment } from '../review-label/github.ts';
import { COMMENT_MARKER, renderComment } from './comment.ts';
import type { Result } from './markdown.ts';

const { GITHUB_EVENT_PATH: eventPath, GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dir = args.find((arg) => arg !== '--dry-run');
if (dir === undefined || !server || !repo || !runId || (!dryRun && !eventPath)) {
  process.stderr.write(
    'usage: post-comment.ts <dir> [--dry-run], with GITHUB_SERVER_URL, GITHUB_REPOSITORY, and GITHUB_RUN_ID set, and GITHUB_EVENT_PATH unless --dry-run\n',
  );
  process.exit(2);
}

/** A job's `result.json` under `root`, or undefined when the job wrote none. */
function read(root: string, artifact: string): Result | undefined {
  const file = path.join(root, artifact, 'result.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Result) : undefined;
}

const pullRequest =
  eventPath === undefined
    ? undefined
    : (JSON.parse(readFileSync(eventPath, 'utf8')) as { pull_request: { number: number; head: { sha: string } } }).pull_request;
const body = renderComment({
  compare: read(dir, 'microbench-compare'),
  repeatability: read(dir, 'microbench-repeatability'),
  runUrl: `${server}/${repo}/actions/runs/${runId}`,
  head: pullRequest?.head.sha,
});
if (dryRun || pullRequest === undefined) {
  process.stdout.write(body);
} else {
  const { number, head } = pullRequest;
  const { repository } = await graphql<{ repository: { pullRequest: { headRefOid: string } } }>(
    'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid } } }',
    { number },
  );
  if (repository.pullRequest.headRefOid === head.sha) {
    await setMarkerComment(number, COMMENT_MARKER, body);
  } else {
    process.stdout.write(`#${number} moved from ${head.sha} to ${repository.pullRequest.headRefOid}; leaving the comment to the newer run\n`);
  }
}
