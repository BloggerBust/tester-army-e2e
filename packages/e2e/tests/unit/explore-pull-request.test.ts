/**
 * The pull request `e2e explore --changed-since` adds to its brief, read from
 * the CI job's environment: a GitHub Actions pull request event's payload or
 * a GitLab merge request pipeline's variables, and nothing anywhere else.
 */

import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPullRequest } from '../../src/explore/pull-request.ts';
import { useTempDirs } from '../helpers/git-repo.ts';

const tempDir = useTempDirs();

/** A GitHub Actions environment for `eventName` whose payload is `payload`, written as JSON unless it is a string. */
function actions(eventName: string, payload: unknown): NodeJS.ProcessEnv {
  const file = path.join(tempDir(), 'event.json');
  writeFileSync(file, typeof payload === 'string' ? payload : JSON.stringify(payload));
  return { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: file };
}

describe('readPullRequest', () => {
  it('reads the pull request of a GitHub pull_request or pull_request_target event', async () => {
    const payload = { action: 'synchronize', number: 42, pull_request: { number: 42, title: 'Fix the bulk discount', body: 'Applies at 3 items.' } };
    expect(await readPullRequest(actions('pull_request', payload))).toEqual({ number: '#42', title: 'Fix the bulk discount', body: 'Applies at 3 items.' });
    expect(await readPullRequest(actions('pull_request_target', payload))).toMatchObject({ number: '#42' });
  });

  it('reads a GitHub pull request with no description as an empty one', async () => {
    expect(await readPullRequest(actions('pull_request', { pull_request: { number: 7, title: 'Tidy', body: null } }))).toEqual({ number: '#7', title: 'Tidy', body: '' });
  });

  it('has none on any other GitHub event, or a payload it cannot read', async () => {
    expect(await readPullRequest(actions('push', { pull_request: { number: 1, title: 'x', body: '' } }))).toBeUndefined();
    expect(await readPullRequest(actions('pull_request', '{not json'))).toBeUndefined();
    expect(await readPullRequest(actions('pull_request', { pull_request: { number: 1 } }))).toBeUndefined();
    expect(await readPullRequest(actions('pull_request', []))).toBeUndefined();
    expect(await readPullRequest({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: path.join(os.tmpdir(), 'e2e-no-such-event.json') })).toBeUndefined();
    expect(await readPullRequest({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request' })).toBeUndefined();
  });

  it('has none when the read is interrupted, leaving the interrupt to the change read after it', async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const env = actions('pull_request', { pull_request: { number: 1, title: 'x', body: '' } });
    expect(await readPullRequest(env, interrupt.signal)).toBeUndefined();
  });

  it('has none for a payload past the size it reads', async () => {
    expect(await readPullRequest(actions('pull_request', `{"pull_request":{"title":"x","body":"${'y'.repeat(8 * 1024 * 1024)}"}}`))).toBeUndefined();
  });

  it('reads the merge request of a GitLab merge request pipeline', async () => {
    const env = { GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '12', CI_MERGE_REQUEST_TITLE: 'Fix sort', CI_MERGE_REQUEST_DESCRIPTION: 'Sorts by price.' };
    expect(await readPullRequest(env)).toEqual({ number: '!12', title: 'Fix sort', body: 'Sorts by price.' });
    expect(await readPullRequest({ GITLAB_CI: 'true', CI_MERGE_REQUEST_TITLE: 'Fix sort' })).toEqual({ number: undefined, title: 'Fix sort', body: '' });
    expect(await readPullRequest({ GITLAB_CI: 'true', CI_COMMIT_BRANCH: 'main' })).toBeUndefined();
  });

  it('has none outside CI, whatever variables are set', async () => {
    expect(await readPullRequest({ CI_MERGE_REQUEST_TITLE: 'Fix sort', GITHUB_EVENT_NAME: 'pull_request' })).toBeUndefined();
  });
});
