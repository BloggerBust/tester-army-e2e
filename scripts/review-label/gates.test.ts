import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READY_MARKER,
  blockedComment,
  readyBlockers,
  readyRequest,
  safeName,
  type Candidate,
  type CommentPayload,
  type Thread,
} from './gates.ts';

const pr = (overrides: Partial<Candidate> = {}): Candidate => ({
  number: 7,
  mergeable: 'MERGEABLE',
  isDraft: false,
  verdicts: [],
  author: 'ada',
  labels: [],
  checks: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  runs: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
  threads: [],
  ...overrides,
});

const payload = (overrides: { issue?: Partial<CommentPayload['issue']>; comment?: Partial<CommentPayload['comment']> } = {}): CommentPayload => ({
  issue: { number: 7, state: 'open', pull_request: {}, user: { id: 1 }, ...overrides.issue },
  comment: { body: '/ready', user: { id: 1 }, ...overrides.comment },
});

test('takes the command from the PR author, alone in the comment', () => {
  assert.equal(readyRequest(payload()), 7);
  assert.equal(readyRequest(payload({ comment: { body: '/ready\r\n' } })), 7);
});

test('ignores the command from anyone else, on an issue, on a closed PR, or among other text', () => {
  assert.equal(readyRequest(payload({ comment: { user: { id: 2 } } })), undefined);
  assert.equal(readyRequest(payload({ comment: { user: null } })), undefined);
  assert.equal(readyRequest(payload({ issue: { user: null }, comment: { user: null } })), undefined);
  assert.equal(readyRequest(payload({ issue: { pull_request: undefined } })), undefined);
  assert.equal(readyRequest(payload({ issue: { state: 'closed' } })), undefined);
  assert.equal(readyRequest(payload({ comment: { body: '/ready please' } })), undefined);
  assert.equal(readyRequest(payload({ comment: { body: 'not /ready' } })), undefined);
  assert.equal(readyRequest(payload({ comment: { body: ' /ready' } })), undefined);
});

test('passes a green, mergeable PR with skipped and neutral checks', () => {
  assert.deepEqual(
    readyBlockers(
      pr({
        checks: [
          { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { name: 'ios', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { name: 'size', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { name: 'deploy', state: 'SUCCESS' },
        ],
      }),
    ),
    [],
  );
});

test('blocks on what makes the label stale', () => {
  assert.deepEqual(readyBlockers(pr({ mergeable: 'CONFLICTING', isDraft: true, verdicts: [{ state: 'CHANGES_REQUESTED', author: 'grace' }] })), [
    'merge conflict',
    'draft',
    'changes requested by grace',
  ]);
});

test('blocks while mergeability is unknown and on the compliance label', () => {
  assert.match(readyBlockers(pr({ mergeable: 'UNKNOWN' }))[0] ?? '', /still computing/);
  assert.deepEqual(readyBlockers(pr({ labels: ['size:S', 'needs:compliance'] })), ['the `needs:compliance` label is still on']);
});

test('blocks on failing, running, and missing checks', () => {
  assert.deepEqual(
    readyBlockers(
      pr({
        checks: [
          { name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'web', status: 'IN_PROGRESS', conclusion: null },
          { name: 'android', status: 'QUEUED' },
          { name: 'deploy', state: 'PENDING' },
          { name: 'legacy', state: 'ERROR' },
          { name: 'stale', status: 'COMPLETED', conclusion: 'STALE' },
        ],
      }),
    ),
    ['failing checks: `check`, `legacy`, `stale`', 'checks still running: `web`, `android`, `deploy`'],
  );
  assert.deepEqual(readyBlockers(pr({ checks: [] })), ['no checks have reported on the latest commit']);
});

const thread = (overrides: Partial<Thread> = {}): Thread => ({ isResolved: true, resolvedBy: 'grace', authors: ['grace'], url: 'https://github.com/t/1', ...overrides });

test('treats an outcome it does not know as failing', () => {
  assert.deepEqual(readyBlockers(pr({ checks: [{ name: 'new', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' }] })), ['failing checks: `new`']);
});

test('blocks while workflow runs wait for approval, run, or did not pass', () => {
  // A first-time contributor's PR: the only checks that reported are green.
  assert.deepEqual(
    readyBlockers(
      pr({
        runs: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
          { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
          { status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
        ],
      }),
    ),
    ['2 workflow run(s) waiting for a maintainer to approve them, so CI has not run on the latest commit'],
  );
  assert.deepEqual(
    readyBlockers(
      pr({
        runs: [
          { status: 'QUEUED', conclusion: null },
          { status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
          { status: 'COMPLETED', conclusion: 'SKIPPED' },
        ],
      }),
    ),
    ['1 workflow run(s) still running', '1 workflow run(s) did not pass'],
  );
});

test('blocks on every unresolved thread, answered or not', () => {
  const threads = [
    thread(),
    thread({ isResolved: false, resolvedBy: null, authors: ['grace', 'ada'], url: 'https://github.com/t/2' }),
    thread({ isResolved: false, resolvedBy: null, authors: ['ada'], url: null }),
  ];
  assert.deepEqual(readyBlockers(pr({ threads })), ['2 unresolved review thread(s): [1](https://github.com/t/2), 2']);
});

test('blocks on a thread the author resolved without answering it', () => {
  const quiet = thread({ resolvedBy: 'ada', authors: ['cubic-dev-ai', 'grace'], url: 'https://github.com/t/3' });
  assert.deepEqual(readyBlockers(pr({ threads: [quiet] })), ['1 review thread(s) you resolved without a reply: [1](https://github.com/t/3)']);
  const passing = [
    thread({ resolvedBy: 'ada', authors: ['cubic-dev-ai', 'ada'] }),
    thread({ resolvedBy: 'ada', authors: ['ada'] }),
    thread({ resolvedBy: 'cubic-dev-ai[bot]', authors: ['cubic-dev-ai'] }),
  ];
  assert.deepEqual(readyBlockers(pr({ threads: passing })), []);
});

test('never echoes a check name as written', () => {
  assert.equal(safeName('web (chromium) / shard-1.2'), 'web (chromium) / shard-1.2');
  assert.equal(safeName('`@everyone` ::add-mask::x\n[a](http://b) <img>'), 'everyone add-maskx a(http//b) img');
  assert.equal(safeName('```'), 'unnamed');
  assert.equal(safeName('a'.repeat(80)), `${'a'.repeat(60)}...`);
  const [blocker] = readyBlockers(pr({ checks: [{ name: 'x` @maintainers\n::error::', state: 'FAILURE' }] }));
  assert.equal(blocker, 'failing checks: `x maintainers error`');
});

test('caps a long check list', () => {
  const checks = Array.from({ length: 13 }, (_, index) => ({ name: `job ${index}`, state: 'FAILURE' }));
  assert.match(readyBlockers(pr({ checks }))[0] ?? '', /`job 9`, 3 more$/);
});

test('lists the blockers under the marker', () => {
  const body = blockedComment(['merge conflict', 'draft']);
  assert.ok(body.startsWith(READY_MARKER));
  assert.ok(body.includes('- merge conflict\n- draft\n'));
});
