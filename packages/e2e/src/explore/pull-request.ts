/**
 * The pull request a CI job explores, as the job's own environment names
 * it: the title and description its author wrote for reviewers, which say
 * what the change is for and what a user should see, where commit messages
 * often say neither. GitHub Actions gives them in the event payload of a
 * `pull_request` or `pull_request_target` run, GitLab CI in the merge request
 * variables of a merge request pipeline. Anywhere else, or when the payload
 * cannot be read, there is none and the brief goes without it. The text is
 * the author's, as untrusted as their commit messages: the brief redacts and
 * fences it, and the skip is never decided from it.
 */

import { readFile, stat } from 'node:fs/promises';

/** A pull request or merge request, as its CI job's environment gives it. */
export interface PullRequest {
  /** Its number, `#42` on GitHub or `!42` on GitLab; undefined when the payload has none. */
  readonly number: string | undefined;
  readonly title: string;
  /** Its description, `''` when it has none. */
  readonly body: string;
}

/** The GitHub events whose payload carries the pull request the run is for. */
const PULL_REQUEST_EVENTS: ReadonlySet<string> = new Set(['pull_request', 'pull_request_target']);

/** An event payload larger than this is not read: GitHub's run to a few hundred kilobytes. */
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

/**
 * The pull request the CI job in `env` runs for, or undefined outside a pull
 * request job. Never throws: a payload that is missing, too large, or not the
 * shape GitHub writes is no pull request, and so is one `signal` cut short,
 * since the change read after it reports the interrupt as `INTERRUPTED`.
 */
export async function readPullRequest(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<PullRequest | undefined> {
  if (env['GITHUB_ACTIONS'] === 'true') return githubPullRequest(env, signal);
  if (env['GITLAB_CI'] === 'true') return gitlabMergeRequest(env);
  return undefined;
}

/** The pull request in a GitHub Actions `pull_request` or `pull_request_target` event payload. */
async function githubPullRequest(env: NodeJS.ProcessEnv, signal: AbortSignal | undefined): Promise<PullRequest | undefined> {
  const eventPath = env['GITHUB_EVENT_PATH'];
  if (!PULL_REQUEST_EVENTS.has(env['GITHUB_EVENT_NAME'] ?? '') || eventPath === undefined || eventPath === '') return undefined;
  let payload: unknown;
  try {
    if ((await stat(eventPath)).size > MAX_EVENT_BYTES) return undefined;
    payload = JSON.parse(await readFile(eventPath, { encoding: 'utf8', ...(signal === undefined ? {} : { signal }) }));
  } catch {
    return undefined;
  }
  const pr = isRecord(payload) ? payload['pull_request'] : undefined;
  if (!isRecord(pr) || typeof pr['title'] !== 'string') return undefined;
  const number = pr['number'];
  return {
    number: typeof number === 'number' && Number.isSafeInteger(number) ? `#${number}` : undefined,
    title: pr['title'],
    body: typeof pr['body'] === 'string' ? pr['body'] : '',
  };
}

/** The merge request of a GitLab merge request pipeline, from its predefined variables. */
function gitlabMergeRequest(env: NodeJS.ProcessEnv): PullRequest | undefined {
  const title = env['CI_MERGE_REQUEST_TITLE'];
  if (title === undefined || title === '') return undefined;
  const iid = env['CI_MERGE_REQUEST_IID'];
  return { number: iid !== undefined && /^\d+$/u.test(iid) ? `!${iid}` : undefined, title, body: env['CI_MERGE_REQUEST_DESCRIPTION'] ?? '' };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
