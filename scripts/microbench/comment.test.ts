import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMMENT_MARKER, renderComment } from './comment.ts';
import type { Result } from './markdown.ts';
import { assess, spreadOf } from './stats.ts';

const RUN = 'https://github.com/o/r/actions/runs/1';
const side = (values: number[]) => ({ sha: 'a'.repeat(40), perIteration: values, spread: spreadOf(values) });

/** A result with one jitless row per head list, all against the same base. */
function result(expectSame: boolean, ...heads: number[][]): Result {
  const base = [1000, 1001, 1002];
  return {
    tool: 'cachegrind',
    trials: 3,
    multiplier: 3,
    thresholdPercent: 0.5,
    expectSame,
    flags: { jit: ['--predictable'], jitless: ['--jitless', '--predictable'] },
    machine: 'linux x64',
    rows: heads.map((head, index) => ({
      case: `case-${index}`,
      mode: 'jitless',
      base: side(base),
      head: side(head),
      assessment: assess('cachegrind', base, head, 0.5),
    })),
  };
}

const STABLE = result(true, [1000.5, 1001, 1002]);

describe('renderComment', () => {
  it('names the pull request head, since the table names the merge commit GitHub tests', () => {
    const text = renderComment({ compare: result(false, [1000, 1001, 1002]), repeatability: STABLE, runUrl: RUN, head: 'b'.repeat(40) });
    assert.match(text, /For `bbbbbbbbbbbb`, the pull request's head, measured merged into its base\./);
    assert.doesNotMatch(renderComment({ compare: undefined, repeatability: STABLE, runUrl: RUN, head: undefined }), /pull request's head/);
  });

  it('opens with the marker, so the next run edits the same comment', () => {
    const text = renderComment({ compare: result(false, [1000, 1001, 1002]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.equal(text.split('\n')[0], COMMENT_MARKER);
  });

  it('says nothing changed when no case has a direction', () => {
    const text = renderComment({ compare: result(false, [1000, 1001, 1002]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.match(text, /⚪ No case changed by 0\.5% or more\./);
    assert.match(text, /Repeatability: two builds of the head agree in every case, 3 trials each\./);
    assert.match(text, /\| `case-0` \| jitless \| 1,001 \| 1,001 \|/);
    assert.match(text, /<details><summary>How this is measured<\/summary>/);
  });

  it('folds the unchanged cases away and keeps the changed ones in the open table', () => {
    const text = renderComment({ compare: result(false, [1000, 1001, 1002], [1100, 1101, 1102], [1000.5, 1001, 1002], [990, 1010, 1030]), repeatability: STABLE, runUrl: RUN, head: undefined });
    const fold = text.indexOf('<details><summary>2 unchanged cases</summary>');
    assert.notEqual(fold, -1);
    const end = text.indexOf('</details>', fold);
    const open = text.slice(0, fold);
    const folded = text.slice(fold, end);
    assert.match(open, /\| `case-1` \|.*🔴 higher/);
    assert.match(open, /\| `case-3` \|.*⚪ inconclusive/);
    assert.doesNotMatch(open, /`case-0`|`case-2`/);
    assert.match(folded, /\| `case-0` \|.*⚪ same/);
    assert.match(folded, /\| `case-2` \|.*⚪ same/);
    assert.doesNotMatch(folded, /`case-1`|`case-3`/);
  });

  it('opens no table when every case is unchanged, and folds none when every case moved', () => {
    const same = renderComment({ compare: result(false, [1000, 1001, 1002]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.match(same, /<details><summary>1 unchanged case<\/summary>\n\n\| Case \|/);
    assert.equal(same.match(/\| Case \|/g)?.length, 1);
    const moved = renderComment({ compare: result(false, [1100, 1101, 1102]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.doesNotMatch(moved, /unchanged case/);
    assert.equal(moved.match(/\| Case \|/g)?.length, 1);
  });

  it('counts the cases that cost more and less', () => {
    const text = renderComment({ compare: result(false, [1100, 1101, 1102], [1200, 1201, 1202], [900, 901, 902]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.match(text, /🔴 2 cases cost more, 🟢 1 case costs less\./);
  });

  it('does not call a case unchanged when it moved past the floor with overlapping trials', () => {
    const text = renderComment({ compare: result(false, [990, 1010, 1030]), repeatability: STABLE, runUrl: RUN, head: undefined });
    assert.match(text, /⚪ 1 case moved by 0\.5% or more, but the trials do not confirm a direction\./);
    assert.doesNotMatch(text, /No case changed/);
  });

  it('warns that a direction can be noise when two builds of the head landed apart', () => {
    const text = renderComment({ compare: result(false, [1100, 1101, 1102]), repeatability: result(true, [1003, 1003.5, 1004]), runUrl: RUN, head: undefined });
    assert.match(text, /⚠️ Repeatability check failed: two builds of the head landed apart in `case-0` \(jitless\)\./);
  });

  it('says which job left no result, with no table when the comparison is missing', () => {
    const text = renderComment({ compare: undefined, repeatability: undefined, runUrl: RUN, head: undefined });
    assert.match(text, /⚠️ No comparison result: the `compare` job did not finish, or its artifact could not be downloaded\. See the \[workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)\./);
    assert.match(text, /⚠️ No repeatability result: the `repeatability` job did not finish, or its artifact could not be downloaded/);
    assert.doesNotMatch(text, /\| Case \|/);
  });
});
