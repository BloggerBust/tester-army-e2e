/** A target its test id tells apart from same-named twins: once the test id is gone, a lone twin is not taken for it. */

import { describe, expect, it } from 'vitest';
import { describeAction } from '@e2e-dev/core/lib/agent/actions';
import { hasTwinsWithoutTestId, relocateDescriptor } from '@e2e-dev/core/lib/cache/relocate';
import { buildTraceEntry, type ActionTrace } from '@e2e-dev/core/lib/cache/trace';
import { readTraceEntry } from '@e2e-dev/core/lib/cache/trace-read';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import type { RedactedNode } from '@e2e-dev/core/lib/agent/observation';
import { redactedNodes } from '../helpers/redacted.ts';

function button(id: string, testId?: string, name = 'Set up'): SemanticNode {
  return { ref: { id, revision: 'r' }, role: 'button', name, ...(testId === undefined ? {} : { testId }) };
}

/** A named row holding one node: the container key (`within`) is its label. */
function row(id: string, label: string, node: SemanticNode): SemanticNode[] {
  const cell = { ref: { id: `${id}-label`, revision: 'r' }, text: label };
  return [{ ref: { id, revision: 'r' }, role: 'row', children: [cell, node] }, cell, node];
}

function screen(...list: SemanticNode[]): ReadonlyMap<string, RedactedNode> {
  return redactedNodes(list);
}

describe('hasTwinsWithoutTestId', () => {
  it('is true when the fields beside the test id match another control', () => {
    const both = screen(button('a', 'setup-primary'), button('b', 'setup-secondary'));
    expect(hasTwinsWithoutTestId(both.get('a')!, undefined, both)).toBe(true);
    const unlabeled = screen(button('a', 'setup-primary'), button('b'));
    expect(hasTwinsWithoutTestId(unlabeled.get('a')!, undefined, unlabeled)).toBe(true);
  });

  it('is false for a control alone in its fields, one with no test id, or one whose twin sits in another container', () => {
    const alone = screen(button('a', 'setup-primary'), button('s', 'save', 'Save'));
    expect(hasTwinsWithoutTestId(alone.get('a')!, undefined, alone)).toBe(false);
    const noIds = screen(button('a'), button('b'));
    expect(hasTwinsWithoutTestId(noIds.get('a')!, undefined, noIds)).toBe(false);
    const rows = screen(...row('r1', 'Slack', button('a', 'setup-slack')), ...row('r2', 'Linear', button('b', 'setup-linear')));
    expect(hasTwinsWithoutTestId(rows.get('a')!, 'Slack', rows)).toBe(false);
    expect(hasTwinsWithoutTestId(rows.get('a')!, undefined, rows)).toBe(true);
  });

  it('is false for a test id with nothing else to name the control, which has no semantic tier', () => {
    const boxes = screen({ ref: { id: 'a', revision: 'r' }, role: 'box', testId: 'one' }, { ref: { id: 'b', revision: 'r' }, role: 'box', testId: 'two' });
    expect(hasTwinsWithoutTestId(boxes.get('a')!, undefined, boxes)).toBe(false);
  });
});

describe('relocation of a target recorded with twins beside its test id', () => {
  const twinned = { role: 'button', name: 'Set up', testId: 'setup-primary', twinsWithoutTestId: true } as const;

  it('diverges as ambiguous when the test id is gone and one twin is left', () => {
    expect(relocateDescriptor(twinned, screen(button('b', 'setup-secondary')))).toEqual({
      kind: 'failed',
      failure: 'target-ambiguous',
      candidates: ['b'],
      twinLeft: true,
    });
  });

  it('still finds the recorded test id while it is on screen, its twins gone or not', () => {
    expect(relocateDescriptor(twinned, screen(button('a', 'setup-primary')))).toEqual({ kind: 'found', id: 'a' });
    expect(relocateDescriptor(twinned, screen(button('b', 'setup-secondary'), button('a', 'setup-primary')))).toEqual({ kind: 'found', id: 'a' });
  });

  it('still re-finds by text a control counted among a shared test id once the ids change, as main does', () => {
    const textButton = (id: string, text: string, testId: string): SemanticNode => ({ ref: { id, revision: 'r' }, role: 'button', text, testId });
    // Recorded as the first of two buttons sharing test id `dup`; their text told them apart all along.
    const preview = { role: 'button', text: 'Preview', testId: 'dup', position: { index: 0, of: 2 } };
    expect(relocateDescriptor(preview, screen(textButton('a', 'Preview', 'new-1'), textButton('b', 'Publish', 'new-2')))).toEqual({ kind: 'found', id: 'a' });
  });

  it('finds the one left of two controls sharing a test id when it shows the recorded text, and stops on the other', () => {
    const textButton = (id: string, text: string): SemanticNode => ({ ref: { id, revision: 'r' }, role: 'button', text, testId: 'dup' });
    // Recorded as the first of two buttons sharing test id `dup`, told apart only by their text.
    const preview = { role: 'button', text: 'Preview', testId: 'dup', position: { index: 0, of: 2 } };
    expect(relocateDescriptor(preview, screen(textButton('a', 'Preview')))).toEqual({ kind: 'found', id: 'a' });
    expect(relocateDescriptor(preview, screen(textButton('b', 'Publish')))).toEqual({ kind: 'failed', failure: 'target-ambiguous', candidates: ['b'], twinLeft: true });
    // Two with the recorded text too: the text tells nothing apart.
    expect(relocateDescriptor({ ...preview, twinsWithoutTestId: true }, screen(textButton('a', 'Preview')))).toMatchObject({ kind: 'failed', twinLeft: true });
  });

  it('still forgives a changed test id on a control recorded without twins', () => {
    expect(relocateDescriptor({ role: 'button', name: 'Set up', testId: 'setup-primary' }, screen(button('b', 'setup-renamed')))).toEqual({
      kind: 'found',
      id: 'b',
    });
  });
});

describe('a count taken on a look an earlier action of the step ran from', () => {
  it('does not stop a lone match, so the step replays as main replays it', () => {
    expect(relocateDescriptor({ role: 'button', name: 'Set up', position: { index: 1, of: 2 }, countedOnEarlierLook: true }, screen(button('b')))).toEqual({ kind: 'found', id: 'b' });
    expect(relocateDescriptor({ role: 'button', name: 'Set up', testId: 'setup-a', twinsWithoutTestId: true, countedOnEarlierLook: true }, screen(button('b', 'setup-b')))).toEqual({
      kind: 'found',
      id: 'b',
    });
  });

  it('still picks by a count that matches, as main does', () => {
    expect(relocateDescriptor({ role: 'button', name: 'Set up', position: { index: 1, of: 2 }, countedOnEarlierLook: true }, screen(button('a'), button('b')))).toEqual({ kind: 'found', id: 'b' });
  });

  it('survives the store, and is refused without a count to qualify', () => {
    const payload: ActionTrace = {
      actions: [{ name: 'tap', summary: 'tap button "Set up" (2 of 2)', target: { role: 'button', name: 'Set up', position: { index: 1, of: 2 }, countedOnEarlierLook: true } }],
      executor: { name: 'example-agent', version: '1' },
      summary: 'set up both',
      startPath: '/integrations',
    };
    const stored = JSON.parse(JSON.stringify(buildTraceEntry(payload)));
    expect(readTraceEntry(stored)?.payload.actions[0]).toMatchObject({ target: { countedOnEarlierLook: true } });
    const bare = JSON.parse(JSON.stringify(stored));
    delete bare.payload.actions[0].target.position;
    expect(readTraceEntry(bare)).toBeUndefined();
    const wrong = JSON.parse(JSON.stringify(stored));
    wrong.payload.actions[0].target.countedOnEarlierLook = 'yes';
    expect(readTraceEntry(wrong)).toBeUndefined();
  });
});

describe('the recorded flag', () => {
  it('rides on the target from the placement', () => {
    const cards = screen(button('a', 'setup-primary'), button('b', 'setup-secondary'));
    const described = describeAction({ name: 'tap', node: cards.get('a')!, twinsWithoutTestId: true }, { redact: (text) => text, redactCut: (text) => text });
    expect(described.target).toEqual({ role: 'button', name: 'Set up', testId: 'setup-primary', twinsWithoutTestId: true });
  });

  it('survives the store and rejects a malformed flag or one without a test id', () => {
    const payload: ActionTrace = {
      actions: [{ name: 'tap', summary: 'tap button "Set up"', target: { role: 'button', name: 'Set up', testId: 'setup-primary', twinsWithoutTestId: true } }],
      executor: { name: 'example-agent', version: '1' },
      summary: 'set up the integration',
      startPath: '/integrations',
    };
    const stored = JSON.parse(JSON.stringify(buildTraceEntry(payload)));
    expect(readTraceEntry(stored)?.payload.actions[0]).toMatchObject({ target: { twinsWithoutTestId: true } });
    for (const flag of [false, 'true', 1]) {
      const broken = JSON.parse(JSON.stringify(stored));
      broken.payload.actions[0].target.twinsWithoutTestId = flag;
      expect(readTraceEntry(broken)).toBeUndefined();
    }
    const withoutTestId = JSON.parse(JSON.stringify(stored));
    delete withoutTestId.payload.actions[0].target.testId;
    expect(readTraceEntry(withoutTestId)).toBeUndefined();
  });
});
