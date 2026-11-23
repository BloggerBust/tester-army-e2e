import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staleReasons, type LabeledPullRequest } from './stale.ts';

const pr = (overrides: Partial<LabeledPullRequest> = {}): LabeledPullRequest => ({
  number: 1,
  mergeable: 'MERGEABLE',
  isDraft: false,
  verdicts: [],
  ...overrides,
});

test('keeps the label on a mergeable PR, approved or not reviewed', () => {
  assert.deepEqual(staleReasons(pr()), []);
  assert.deepEqual(staleReasons(pr({ verdicts: [{ state: 'APPROVED', author: 'ada' }] })), []);
});

test('keeps the label while mergeability is still unknown', () => {
  assert.deepEqual(staleReasons(pr({ mergeable: 'UNKNOWN' })), []);
});

test('keeps the label once a change request is dismissed', () => {
  assert.deepEqual(staleReasons(pr({ verdicts: [{ state: 'DISMISSED', author: 'ada' }] })), []);
});

test('drops the label on a conflict, a draft, or a standing change request', () => {
  assert.deepEqual(staleReasons(pr({ mergeable: 'CONFLICTING' })), ['merge conflict']);
  assert.deepEqual(staleReasons(pr({ isDraft: true })), ['draft']);
  assert.deepEqual(
    staleReasons(
      pr({
        verdicts: [
          { state: 'CHANGES_REQUESTED', author: 'ada' },
          { state: 'APPROVED', author: 'grace' },
          { state: 'CHANGES_REQUESTED', author: null },
        ],
      }),
    ),
    ['changes requested by ada, ghost'],
  );
});

test('lists every cause at once', () => {
  assert.deepEqual(staleReasons(pr({ mergeable: 'CONFLICTING', isDraft: true, verdicts: [{ state: 'CHANGES_REQUESTED', author: 'ada' }] })), [
    'merge conflict',
    'draft',
    'changes requested by ada',
  ]);
});
