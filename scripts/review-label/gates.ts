/**
 * What a pull request must pass before its author's `/ready` comment earns
 * the `Ready for Human Review` label, as pure functions for `ready.ts`.
 *
 * Everything here that reaches a comment or the job log is a fixed string, a
 * count, a GitHub login, a link GitHub built, or a check name cut down by
 * `safeName`: a fork
 * controls its check names, so they are never echoed as written.
 */

import { staleReasons, type LabeledPullRequest } from './stale.ts';

const READY_COMMAND = '/ready';

/** Hidden marker that finds the reply to a `/ready` that fell short. */
export const READY_MARKER = '<!-- review-ready -->';

const GUIDELINES = 'https://github.com/e2e-inc/e2e/blob/main/CONTRIBUTING.md#ready-for-human-review';

const COMPLIANCE_LABEL = 'needs:compliance';

// Anything else, a value GitHub adds later included, counts as failing.
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING = new Set(['PENDING', 'EXPECTED']);

/** A CheckRun carries `status` and `conclusion`; a legacy StatusContext only `state`. */
export interface Check {
  name: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
}

export interface Thread {
  isResolved: boolean;
  resolvedBy: string | null;
  /** Who wrote each comment, the one that opened the thread first. */
  authors: (string | null)[];
  url: string | null;
}

export interface Candidate extends LabeledPullRequest {
  author: string | null;
  labels: string[];
  checks: Check[];
  /**
   * The workflow runs on the head. One held for a maintainer's approval, as a
   * first-time contributor's are, starts no job and so shows up in no check.
   */
  runs: { status: string; conclusion: string | null }[];
  threads: Thread[];
}

/** The slice of an `issue_comment` payload the command reads. */
export interface CommentPayload {
  issue: { number: number; state: string; pull_request?: unknown; user: { id: number } | null };
  comment: { body: string; user: { id: number } | null };
}

/**
 * The PR a comment asks to mark ready, or undefined for anything else: a
 * comment on an issue or a closed PR, from someone other than the PR's
 * author, or with any text besides the command.
 */
export function readyRequest({ issue, comment }: CommentPayload): number | undefined {
  if (issue.pull_request === undefined || issue.state !== 'open') return undefined;
  if (issue.user === null || comment.user?.id !== issue.user.id) return undefined;
  return comment.body.trimEnd() === READY_COMMAND ? issue.number : undefined;
}

/** A check name reduced to plain characters, short enough to list. */
export function safeName(name: string): string {
  const plain = name.replace(/\s+/g, ' ').replace(/[^A-Za-z0-9 ._/()-]/g, '').trim();
  return plain.length > 60 ? `${plain.slice(0, 60)}...` : plain || 'unnamed';
}

function listed(checks: Check[]): string {
  return capped(checks.map(({ name }) => `\`${safeName(name)}\``));
}

/** The first ten of `items`, then how many more there are. */
function capped(items: string[]): string {
  const shown = items.slice(0, 10);
  if (items.length > shown.length) shown.push(`${items.length - shown.length} more`);
  return shown.join(', ');
}

/** GitHub's own links to `items`, for a blocker that points at them. */
function linked(items: { url: string | null }[]): string {
  return capped(items.map(({ url }, index) => (url === null ? `${index + 1}` : `[${index + 1}](${url})`)));
}

/** What still stands between the PR and the label; empty when it is ready. */
export function readyBlockers(pr: Candidate): string[] {
  const blockers = staleReasons(pr);
  if (pr.mergeable === 'UNKNOWN') blockers.push(`GitHub is still computing whether it merges cleanly; comment \`${READY_COMMAND}\` again in a minute`);
  if (pr.labels.includes(COMPLIANCE_LABEL)) blockers.push(`the \`${COMPLIANCE_LABEL}\` label is still on`);
  const failing: Check[] = [];
  const pending: Check[] = [];
  for (const check of pr.checks) {
    const outcome = check.conclusion ?? check.state;
    if (check.status !== undefined && check.status !== 'COMPLETED') pending.push(check);
    else if (outcome === undefined || outcome === null || PENDING.has(outcome)) pending.push(check);
    else if (!PASSED.has(outcome)) failing.push(check);
  }
  if (pr.checks.length === 0) blockers.push('no checks have reported on the latest commit');
  if (failing.length > 0) blockers.push(`failing checks: ${listed(failing)}`);
  if (pending.length > 0) blockers.push(`checks still running: ${listed(pending)}`);
  const done = pr.runs.filter(({ status }) => status === 'COMPLETED');
  const held = done.filter(({ conclusion }) => conclusion === 'ACTION_REQUIRED');
  const broken = done.filter(({ conclusion }) => conclusion !== 'ACTION_REQUIRED' && (conclusion === null || !PASSED.has(conclusion)));
  if (held.length > 0) blockers.push(`${held.length} workflow run(s) waiting for a maintainer to approve them, so CI has not run on the latest commit`);
  if (done.length < pr.runs.length) blockers.push(`${pr.runs.length - done.length} workflow run(s) still running`);
  if (broken.length > 0) blockers.push(`${broken.length} workflow run(s) did not pass`);
  // A review thread is never cleared by the author alone and unseen: it has to
  // be resolved, and one somebody else opened needs the author's reply before
  // the author resolves it.
  const unresolved = pr.threads.filter(({ isResolved }) => !isResolved);
  if (unresolved.length > 0) blockers.push(`${unresolved.length} unresolved review thread(s): ${linked(unresolved)}`);
  const silenced = pr.threads.filter(
    ({ isResolved, resolvedBy, authors }) => isResolved && resolvedBy === pr.author && !authors.includes(pr.author),
  );
  if (silenced.length > 0) blockers.push(`${silenced.length} review thread(s) you resolved without a reply: ${linked(silenced)}`);
  return blockers;
}

/** The reply to a `/ready` that fell short. */
export function blockedComment(blockers: readonly string[]): string {
  return [
    READY_MARKER,
    `\`${READY_COMMAND}\` did not add the \`Ready for Human Review\` label yet:`,
    '',
    ...blockers.map((blocker) => `- ${blocker}`),
    '',
    `Fix these and comment \`${READY_COMMAND}\` again. [How the label works](${GUIDELINES}).`,
  ].join('\n');
}
