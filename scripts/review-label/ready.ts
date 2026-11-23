/**
 * Handles a `/ready` comment from a pull request's author
 * (`.github/workflows/review-ready.yml`): adds `Ready for Human Review` when
 * the PR passes the gates in `gates.ts`, and otherwise replies with what is
 * missing, in one comment edited in place. Contributors from forks cannot add
 * labels themselves.
 *
 * Reads the comment from the `issue_comment` payload at `GITHUB_EVENT_PATH`
 * and the PR live. Never checks out or runs the PR's code, and writes nothing
 * the PR controls to a comment or the log beyond what `gates.ts` allows.
 * `--dry-run` prints the verdict and changes nothing.
 */

import { readFileSync } from 'node:fs';
import {
  READY_MARKER,
  blockedComment,
  readyBlockers,
  readyRequest,
  type Candidate,
  type Check,
  type CommentPayload,
} from './gates.ts';
import { addReadyLabel, graphql, removeReadyLabel, setMarkerComment } from './github.ts';
import { staleReasons } from './stale.ts';

interface Connection<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

type Context = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string };

interface PullRequest {
  state: string;
  isDraft: boolean;
  mergeable: string;
  headRefOid: string;
  author: { login: string } | null;
  labels: { nodes: { name: string }[] };
  latestOpinionatedReviews: { nodes: { state: string; author: { login: string } | null }[] };
  reviewThreads: Connection<{
    isResolved: boolean;
    resolvedBy: { login: string } | null;
    comments: { nodes: { url: string; author: { login: string } | null }[] };
  }>;
  commits: {
    nodes: {
      commit: {
        checkSuites: { nodes: { status: string; conclusion: string | null; workflowRun: { databaseId: number } | null }[] };
        statusCheckRollup: { contexts: Connection<Context> } | null;
      };
    }[];
  };
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!, $threads: String, $checks: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft mergeable headRefOid
      author { login }
      labels(first: 100) { nodes { name } }
      latestOpinionatedReviews(first: 100, writersOnly: true) { nodes { state author { login } } }
      reviewThreads(first: 50, after: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved resolvedBy { login } comments(first: 100) { nodes { url author { login } } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 100) { nodes { status conclusion workflowRun { databaseId } } }
            statusCheckRollup {
              contexts(first: 100, after: $checks) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * The PR as it is now, with every review thread and every check
 * on its head. `moved` when a push landed between pages, which leaves checks
 * from two heads mixed together.
 */
async function snapshot(number: number): Promise<Candidate & { state: string; head: string; moved: boolean }> {
  const threads: Candidate['threads'] = [];
  const checks: Check[] = [];
  const cursors: Record<'threads' | 'checks', string | null> = { threads: null, checks: null };
  let head: string | undefined;
  for (;;) {
    const data: { repository: { pullRequest: PullRequest } } = await graphql(QUERY, { number, ...cursors });
    const pr = data.repository.pullRequest;
    head ??= pr.headRefOid;
    const commit = pr.commits.nodes[0]?.commit;
    const contexts = commit?.statusCheckRollup?.contexts;
    // A page past a list's end is empty, so a list that ends first is not read twice.
    for (const thread of pr.reviewThreads.nodes) {
      threads.push({
        isResolved: thread.isResolved,
        resolvedBy: thread.resolvedBy?.login ?? null,
        authors: thread.comments.nodes.map(({ author }) => author?.login ?? null),
        url: thread.comments.nodes[0]?.url ?? null,
      });
    }
    for (const context of contexts?.nodes ?? []) checks.push({ ...context, name: context.name ?? context.context ?? '' });
    const pages = { threads: pr.reviewThreads.pageInfo, checks: contexts?.pageInfo };
    let more = false;
    for (const key of ['threads', 'checks'] as const) {
      cursors[key] = pages[key]?.endCursor ?? cursors[key];
      more ||= pages[key]?.hasNextPage === true;
    }
    const moved = pr.headRefOid !== head;
    if (more && !moved) continue;
    return {
      number,
      state: pr.state,
      head: pr.headRefOid,
      moved,
      // Apps that never report leave a queued suite with no run behind it.
      runs: (commit?.checkSuites.nodes ?? []).filter(({ workflowRun }) => workflowRun !== null),
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      author: pr.author?.login ?? null,
      labels: pr.labels.nodes.map(({ name }) => name),
      verdicts: pr.latestOpinionatedReviews.nodes.map(({ state, author }) => ({ state, author: author?.login ?? null })),
      threads,
      checks,
    };
  }
}

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  process.stderr.write('GITHUB_EVENT_PATH is required\n');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');
const number = readyRequest(JSON.parse(readFileSync(eventPath, 'utf8')) as CommentPayload);
if (number === undefined) {
  console.log('not a /ready comment from the author of an open PR; nothing to do');
  process.exit(0);
}

const pr = await snapshot(number);
if (pr.state !== 'OPEN') {
  console.log(`#${number} is no longer open; nothing to do`);
  process.exit(0);
}
const blockers = pr.moved ? ['a push landed while the PR was being checked; comment `/ready` again once its checks are green'] : readyBlockers(pr);
if (blockers.length > 0) {
  console.log(`#${number} is not ready:\n${blockers.map((blocker) => `- ${blocker}`).join('\n')}`);
  if (!dryRun) await setMarkerComment(number, READY_MARKER, blockedComment(blockers));
  process.exit(0);
}
console.log(`#${number} is ready at ${pr.head}${dryRun ? ' (dry run)' : ''}`);
if (dryRun) process.exit(0);
await addReadyLabel(number);
await setMarkerComment(number, READY_MARKER, undefined);
// The label vouches for the head the gates read. A push or a move to draft in
// between ran its own label drop before the label existed, so it is taken
// back here.
const after = await snapshot(number);
if (after.head !== pr.head || staleReasons(after).length > 0) {
  console.log(`#${number} changed meanwhile; removing the label`);
  await removeReadyLabel(number);
}
