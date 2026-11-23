/**
 * The GitHub API calls the review-label scripts make, over `fetch` with the
 * workflow's `GITHUB_TOKEN` against `GITHUB_REPOSITORY`.
 */

import { READY_LABEL } from './stale.ts';

const API = 'https://api.github.com';

/** The account `GITHUB_TOKEN` comments as. */
const BOT_LOGIN = 'github-actions[bot]';

/** The token and `owner/name` from the Actions environment; exits when either is missing. */
function env(): { token: string; repo: string } {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    process.stderr.write('GITHUB_TOKEN and GITHUB_REPOSITORY are required\n');
    process.exit(2);
  }
  return { token, repo };
}

/** One authenticated request; throws on a non-2xx response. */
async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${env().token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return response.status === 204 ? undefined : response.json();
}

/** A REST call under `/repos/{owner}/{name}`. */
function rest(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  return request(`/repos/${env().repo}${path}`, init);
}

/** A GraphQL query with `owner` and `name` bound to the repository. */
export async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const [owner, name] = env().repo.split('/');
  const result = (await request('/graphql', { method: 'POST', body: { query, variables: { owner, name, ...variables } } })) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (result.errors?.length) throw new Error(result.errors.map(({ message }) => message).join('; '));
  if (result.data === undefined) throw new Error('GraphQL response without data');
  return result.data;
}

export async function addReadyLabel(number: number): Promise<void> {
  await rest(`/issues/${number}/labels`, { method: 'POST', body: { labels: [READY_LABEL] } });
}

/** Removes the label, ignoring one that is already gone. */
export async function removeReadyLabel(number: number): Promise<void> {
  try {
    await rest(`/issues/${number}/labels/${encodeURIComponent(READY_LABEL)}`, { method: 'DELETE' });
  } catch (error) {
    if (!String(error).includes(': 404 ')) throw error;
  }
}

interface Comment {
  id: number;
  body: string;
  user: { login: string } | null;
}

/**
 * Keeps one comment carrying `marker` on a PR: `body` replaces it, and
 * `undefined` deletes it. Only the workflow's own comments count, so a
 * marker pasted by someone else is never touched.
 */
export async function setMarkerComment(number: number, marker: string, body: string | undefined): Promise<void> {
  let existing: Comment | undefined;
  for (let page = 1; existing === undefined; page++) {
    const batch = (await rest(`/issues/${number}/comments?per_page=100&page=${page}`)) as Comment[];
    existing = batch.find((comment) => comment.user?.login === BOT_LOGIN && comment.body.includes(marker));
    if (batch.length < 100) break;
  }
  if (body === undefined) {
    if (existing !== undefined) await rest(`/issues/comments/${existing.id}`, { method: 'DELETE' });
  } else if (existing === undefined) {
    await rest(`/issues/${number}/comments`, { method: 'POST', body: { body } });
  } else if (existing.body !== body) {
    await rest(`/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
  }
}
