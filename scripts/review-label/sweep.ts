/**
 * Removes `Ready for Human Review` from every open pull request it no longer
 * describes: one with a merge conflict, a standing change request, or back in
 * draft (`.github/workflows/review-label.yml`, when the base branch moves and
 * when a review requests changes).
 *
 * Reads the labeled PRs live. Never checks out or runs a PR's code. `--dry-run`
 * lists what it would remove and changes nothing.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { graphql, removeReadyLabel } from './github.ts';
import { READY_LABEL, staleReasons, type LabeledPullRequest } from './stale.ts';

// GitHub computes mergeability lazily after the base moves; asking starts it.
const MERGEABLE_ATTEMPTS = 6;
const MERGEABLE_WAIT_MS = 10_000;

const dryRun = process.argv.includes('--dry-run');

interface Page {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        mergeable: string;
        isDraft: boolean;
        latestOpinionatedReviews: { nodes: { state: string; author: { login: string } | null }[] };
      }[];
    };
  };
}

/** Every open pull request that carries the label. */
async function labeled(): Promise<LabeledPullRequest[]> {
  const all: LabeledPullRequest[] = [];
  let after: string | null = null;
  do {
    const { repository }: Page = await graphql<Page>(
      `query($owner: String!, $name: String!, $label: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: OPEN, labels: [$label], first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number mergeable isDraft
              latestOpinionatedReviews(first: 100, writersOnly: true) { nodes { state author { login } } }
            }
          }
        }
      }`,
      { label: READY_LABEL, after },
    );
    const page: Page['repository']['pullRequests'] = repository.pullRequests;
    for (const node of page.nodes) {
      all.push({
        number: node.number,
        mergeable: node.mergeable,
        isDraft: node.isDraft,
        verdicts: node.latestOpinionatedReviews.nodes.map(({ state, author }) => ({ state, author: author?.login ?? null })),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after !== null);
  return all;
}

/** The labeled PRs, asked again while GitHub still owes a mergeability. */
async function settled(): Promise<LabeledPullRequest[]> {
  let prs = await labeled();
  for (let attempt = 1; attempt < MERGEABLE_ATTEMPTS && prs.some(({ mergeable }) => mergeable === 'UNKNOWN'); attempt++) {
    await delay(MERGEABLE_WAIT_MS);
    prs = await labeled();
  }
  return prs;
}

let removed = 0;
for (const pr of await settled()) {
  const reasons = staleReasons(pr);
  if (reasons.length === 0) {
    if (pr.mergeable === 'UNKNOWN') console.log(`#${pr.number}: mergeability still unknown, left for the next run`);
    continue;
  }
  removed++;
  console.log(`${dryRun ? 'would remove' : 'removing'} the label from #${pr.number}: ${reasons.join('; ')}`);
  if (dryRun) continue;
  await removeReadyLabel(pr.number);
}
console.log(`${dryRun ? 'would remove' : 'removed'} the label from ${removed} PR(s)`);
