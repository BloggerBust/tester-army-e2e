import { describe, expect as vexpect, it } from 'vitest';
import type { SemanticNode } from '@e2e-dev/core/lib/engine/surface';
import type { AsyncExpectation } from '@e2e-dev/core/lib/types';
import { expect as expectFixture } from '../../src/expect/index.ts';
import { createScreenFixture } from '../helpers/screen-fixture.ts';
import { useFakeTime } from '../helpers/fake-time.ts';

useFakeTime();

let nextId = 0;
/** A node found by its test id, with the fields a case sets. */
function node(testId: string, fields: Omit<SemanticNode, 'ref' | 'testId'>): SemanticNode {
  nextId += 1;
  return { ref: { id: `node-${String(nextId)}`, revision: '' }, testId, ...fields };
}

const NODES: readonly SemanticNode[] = [
  node('blank', { role: 'textbox', name: 'Search', states: { empty: true } }),
  node('filled', { role: 'textbox', name: 'Search', value: 'ada', states: { empty: false } }),
  // What the node shows is the engine's to judge: the matcher reads the state alone.
  node('says-empty', { role: 'combobox', name: 'Fruit', text: 'Pick one', states: { empty: true } }),
  node('no-state', { role: 'textbox', name: 'Search', value: '' }),
  node('secret', { role: 'textbox', name: 'Password', states: { secure: true } }),
  node('twin', { role: 'textbox', name: 'One', states: { empty: true } }),
  node('twin', { role: 'textbox', name: 'Two', states: { empty: true } }),
];

const screen = createScreenFixture(NODES);
const at = (testId: string, message?: string): AsyncExpectation => expectFixture(screen.getByTestId(testId), message);
const soon = { timeout: 100 };
const failsAssertion = { code: 'ASSERTION_FAILED' };

describe('toBeEmpty', () => {
  it('reads the engine empty state', async () => {
    await at('blank').toBeEmpty();
    await at('filled').not.toBeEmpty();
    await at('says-empty').toBeEmpty();
  });

  it('names the wanted state and what it read', async () => {
    await vexpect(at('filled', 'the search box is clear').toBeEmpty(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: [
        'the search box is clear: expect.toBeEmpty failed',
        'locator: getByTestId("filled")',
        'expected: empty',
        'observed: not empty (match count 1)',
      ].join('\n'),
    });
    await vexpect(at('blank').not.toBeEmpty(soon)).rejects.toMatchObject({
      ...failsAssertion,
      message: vexpect.stringContaining('expected: not empty\nobserved: empty'),
    });
  });

  it('fails either way on a node the engine reports no empty state for', async () => {
    for (const run of [at('no-state').toBeEmpty(soon), at('no-state').not.toBeEmpty(soon)]) {
      await vexpect(run).rejects.toMatchObject({
        ...failsAssertion,
        message: vexpect.stringContaining('observed: no empty state, which this engine does not report'),
      });
    }
  });

  it('refuses to judge a secure field, whose value is withheld, negated or not', async () => {
    const denied = { code: 'POLICY_DENIED', message: 'reading values from a secure field is denied: getByTestId("secret")' };
    await vexpect(at('secret').toBeEmpty()).rejects.toMatchObject(denied);
    await vexpect(at('secret').not.toBeEmpty()).rejects.toMatchObject(denied);
  });

  it('keeps polling while nothing matches, negated or not', async () => {
    for (const run of [at('nowhere').toBeEmpty(soon), at('nowhere').not.toBeEmpty(soon)]) {
      await vexpect(run).rejects.toMatchObject({ ...failsAssertion, message: vexpect.stringContaining('observed: no node') });
    }
  });

  it('fails an ambiguous locator at once', async () => {
    await vexpect(at('twin').toBeEmpty(soon)).rejects.toMatchObject({ code: 'LOCATOR_AMBIGUOUS' });
  });
});
