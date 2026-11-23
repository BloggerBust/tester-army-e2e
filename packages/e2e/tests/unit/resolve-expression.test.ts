/**
 * `resolveExpression`, the reference locator semantics an engine over a
 * semantic tree reproduces. The screen is an iOS Settings page as the mobile
 * engine projects one: an application node, a navigation bar with a button,
 * a cell echoing its static text, a switch, two fields, a hidden button.
 */

import { describe, expect, it } from 'vitest';
import {
  resolveExpression,
  type LocatorExpression,
  type SemanticNode,
  type SemanticQuery,
  type TextPattern,
} from '@e2e-dev/core/lib/engine/index';

function node(id: string, fields: Omit<SemanticNode, 'ref'>): SemanticNode {
  return { ref: { id, revision: '' }, ...fields };
}

const SETTINGS: readonly SemanticNode[] = [
  node('app', {
    role: 'application',
    name: 'Settings',
    text: 'Settings',
    children: [
      node('bar', {
        role: 'navigation',
        name: 'General',
        text: 'General',
        children: [node('back', { role: 'button', name: 'Back', text: 'Back', testId: 'BackButton' })],
      }),
      node('about', {
        role: 'listitem',
        name: 'About',
        text: 'About',
        testId: 'ABOUT',
        children: [node('about-text', { role: 'text', name: 'About', text: 'About' })],
      }),
      node('airplane', { role: 'switch', name: 'Airplane Mode', text: 'Airplane Mode', states: { checked: false } }),
      node('search', { role: 'textbox', name: 'Search', text: 'Search', value: 'wifi' }),
      node('password', {
        role: 'textbox',
        name: 'Password',
        text: 'Password',
        inputPurpose: 'password',
        states: { secure: true },
      }),
      node('hidden', { role: 'button', name: 'Hidden', text: 'Hidden', states: { hidden: true, disabled: true } }),
      node('scroller', { role: 'listitem', name: 'Scroller', text: 'Scroller' }),
    ],
  }),
];

function exact(value: string): TextPattern {
  return { kind: 'string', value, exact: true };
}

function query(kind: SemanticQuery['kind'], value: string, extra: object = {}): LocatorExpression {
  return { kind: 'query', query: { kind, value: exact(value), ...extra } };
}

function ids(expression: LocatorExpression, nodes: readonly SemanticNode[] = SETTINGS): string[] {
  return resolveExpression(expression, nodes).map((match) => match.ref.id);
}

describe('resolveExpression', () => {
  it('answers role queries with name filters and skips hidden nodes', () => {
    expect(ids(query('role', 'button'))).toEqual(['back']);
    expect(ids(query('role', 'button', { name: exact('Back') }))).toEqual(['back']);
    expect(ids(query('role', 'button', { name: { kind: 'regexp', source: '^ba', flags: 'i' } }))).toEqual(['back']);
    expect(ids(query('role', 'switch', { states: { checked: true } }))).toEqual([]);
    expect(ids(query('role', 'switch', { states: { checked: false } }))).toEqual(['airplane']);
    expect(ids(query('role', 'listitem'))).toEqual(['about', 'scroller']);
  });

  it('requires a heading level exactly, so a tree without levels answers nothing', () => {
    const headings = [node('h1', { role: 'heading', level: 1 }), node('h2', { role: 'heading', level: 2 }), node('h', { role: 'heading' })];
    expect(ids(query('role', 'heading', { level: 2 }), headings)).toEqual(['h2']);
    expect(ids(query('role', 'heading'), headings)).toEqual(['h1', 'h2', 'h']);
    expect(ids(query('role', 'listitem', { level: 1 }))).toEqual([]);
  });

  it('refuses a role query whose value is not a string', () => {
    expect(() => ids({ kind: 'query', query: { kind: 'role', value: { kind: 'regexp', source: 'but', flags: '' } } })).toThrowError(
      expect.objectContaining({ code: 'ENGINE_FAILURE' }),
    );
  });

  it('drops hidden nodes from any query kind when it says visible', () => {
    expect(ids(query('text', 'Hidden'))).toEqual(['hidden']);
    expect(ids(query('text', 'Hidden', { visible: true }))).toEqual([]);
    expect(ids(query('role', 'button', { states: { hidden: true }, visible: true }))).toEqual(['back']);
    expect(ids(query('label', 'Search', { visible: true }))).toEqual(['search']);
    expect(ids({ kind: 'index', source: query('text', 'About', { visible: true }), index: 'last' })).toEqual(['about-text']);
  });

  it('answers label, text, display value, placeholder, and test id queries', () => {
    expect(ids(query('label', 'Search'))).toEqual(['search']);
    expect(ids(query('text', 'About'))).toEqual(['about-text']);
    expect(ids({ kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'abo', exact: false } } })).toEqual([
      'about-text',
    ]);
    expect(ids(query('displayValue', 'wifi'))).toEqual(['search']);
    expect(ids(query('displayValue', 'hunter2'))).toEqual([]);
    expect(ids(query('testId', 'ABOUT'))).toEqual(['about']);
    expect(ids(query('placeholder', 'anything'))).toEqual([]);
    const field = [node('email', { role: 'textbox', attributes: { placeholder: 'you@example.test' } })];
    expect(ids(query('placeholder', 'you@example.test'), field)).toEqual(['email']);
  });

  it('answers text and label queries with the innermost match when an ancestor echoes the text', () => {
    expect(resolveExpression(query('text', 'About'), SETTINGS).map((match) => match.role)).toEqual(['text']);
    expect(ids(query('label', 'About'))).toEqual(['about-text']);
    // The echoing cell still answers role queries, and filters by its subtree text.
    expect(ids(query('role', 'listitem', { name: exact('About') }))).toEqual(['about']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') })).toEqual(['about']);
  });

  it('reads text from the name or the visible text', () => {
    const nodes = [node('named', { role: 'button', name: 'Save' }), node('texted', { text: 'Save' }), node('other', { name: 'Cancel' })];
    expect(ids(query('text', 'Save'), nodes)).toEqual(['named', 'texted']);
    expect(ids(query('label', 'Save'), nodes)).toEqual(['named']);
  });

  it('scopes, filters, and indexes', () => {
    const inBar: LocatorExpression = {
      kind: 'query',
      query: { kind: 'role', value: exact('button') },
      scope: query('role', 'navigation'),
    };
    expect(ids(inBar)).toEqual(['back']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), hasText: exact('About') })).toEqual(['about']);
    expect(ids({ kind: 'filter', source: query('role', 'listitem'), has: query('role', 'text') })).toEqual(['about']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 'first' })).toEqual(['about']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 'last' })).toEqual(['scroller']);
    expect(ids({ kind: 'index', source: query('role', 'listitem'), index: 5 })).toEqual([]);
  });

  it('searches strict descendants of a scope, each once, in document order', () => {
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('application') }, scope: query('role', 'application') })).toEqual([]);
    const nested = [
      node('outer', {
        role: 'group',
        children: [node('inner', { role: 'group', children: [node('leaf', { role: 'button' })] }), node('sibling', { role: 'button' })],
      }),
    ];
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('button') }, scope: query('role', 'group') }, nested)).toEqual([
      'leaf',
      'sibling',
    ]);
    expect(ids({ kind: 'query', query: { kind: 'role', value: exact('button') }, scope: query('role', 'list') }, nested)).toEqual([]);
  });

  it('resolves has inside each candidate, never against the whole screen', () => {
    const remove = node('remove', { role: 'button', name: 'Remove' });
    const list = [
      node('alpha', { role: 'listitem', text: 'Alpha', children: [remove] }),
      node('beta', { role: 'listitem', text: 'Beta', children: [node('note', { role: 'text', text: 'Read only' })] }),
    ];
    const items = query('role', 'listitem');
    expect(ids({ kind: 'filter', source: items, has: query('role', 'button', { name: exact('Remove') }) }, list)).toEqual(['alpha']);
    expect(ids({ kind: 'filter', source: items, has: query('text', 'Read only') }, list)).toEqual(['beta']);
    expect(ids({ kind: 'filter', source: items, has: query('role', 'link') }, list)).toEqual([]);
    expect(ids({ kind: 'filter', source: items, hasText: exact('Alpha'), has: query('role', 'button') }, list)).toEqual(['alpha']);
    expect(ids({ kind: 'filter', source: items, hasText: exact('Beta'), has: query('role', 'button') }, list)).toEqual([]);
  });

  it('matches hasText against the name, text, or value of the node or a descendant', () => {
    const rows = [
      node('by-value', { role: 'row', children: [node('field', { role: 'textbox', value: 'draft' })] }),
      node('by-name', { role: 'row', name: 'draft' }),
      node('other', { role: 'row', text: 'final' }),
    ];
    expect(ids({ kind: 'filter', source: query('role', 'row'), hasText: exact('draft') }, rows)).toEqual(['by-value', 'by-name']);
    expect(ids({ kind: 'filter', source: query('role', 'row'), hasText: { kind: 'string', value: 'FIN', exact: false } }, rows)).toEqual([
      'other',
    ]);
  });

  it('hands a selector to the platform hook, and refuses one without it', () => {
    const byTestId = (selector: string, candidates: readonly SemanticNode[]): SemanticNode[] =>
      candidates.filter((candidate) => `id=${candidate.testId ?? ''}` === selector);
    expect(resolveExpression({ kind: 'selector', selector: 'id=ABOUT' }, SETTINGS, { selector: byTestId }).map((m) => m.ref.id)).toEqual([
      'about',
    ]);
    expect(
      resolveExpression(
        { kind: 'filter', source: query('role', 'listitem'), has: { kind: 'selector', selector: 'id=BackButton' } },
        SETTINGS,
        { selector: byTestId },
      ),
    ).toEqual([]);
    expect(() => ids({ kind: 'selector', selector: 'id=ABOUT' })).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY', message: expect.stringContaining('"id=ABOUT"') }),
    );
  });

  it('keeps every innermost text match, however deep or far apart the echoes are', () => {
    const echoes = [
      node('screen', {
        role: 'application',
        name: 'Save',
        children: [
          node('form', {
            name: 'Save',
            children: [node('row', { name: 'Save', children: [node('label', { text: 'Save' })] }), node('note', { text: 'Draft' })],
          }),
          node('footer', { children: [node('button', { name: 'Save', children: [node('icon', { text: 'Draft' })] })] }),
        ],
      }),
      node('toast', { text: 'Save' }),
    ];
    expect(ids(query('text', 'Save'), echoes)).toEqual(['label', 'button', 'toast']);
    // Inside a scope the scope's own echo is not a candidate, and its innermost match still wins.
    const saveIn = (scope: LocatorExpression): LocatorExpression => ({ kind: 'query', query: { kind: 'text', value: exact('Save') }, scope });
    expect(ids(saveIn(query('text', 'Draft')), echoes)).toEqual([]);
    expect(ids(saveIn(query('role', 'application')), echoes)).toEqual([
      'label',
      'button',
    ]);
  });

  it('resolves a nested has inside the subtree of each enclosing match', () => {
    const table = [
      node('t1', {
        role: 'table',
        children: [
          node('r1', { role: 'row', children: [node('c1', { role: 'cell', text: 'Paid' })] }),
          node('r2', { role: 'row', children: [node('c2', { role: 'cell', text: 'Due' }), node('b2', { role: 'button', name: 'Pay' })] }),
        ],
      }),
      node('t2', { role: 'table', children: [node('r3', { role: 'row', children: [node('c3', { role: 'cell', text: 'Due' })] })] }),
    ];
    const dueRows: LocatorExpression = { kind: 'filter', source: query('role', 'row'), has: query('text', 'Due') };
    const payable: LocatorExpression = { kind: 'filter', source: dueRows, has: query('role', 'button') };
    expect(ids({ kind: 'filter', source: query('role', 'table'), has: payable }, table)).toEqual(['t1']);
    expect(ids({ kind: 'filter', source: query('role', 'table'), has: dueRows, hasNot: payable }, table)).toEqual(['t2']);
    expect(ids({ kind: 'filter', source: query('role', 'table'), has: { kind: 'union', left: query('text', 'Paid'), right: query('role', 'button') } }, table)).toEqual([
      't1',
    ]);
    // A union inside a scope answers in document order, each node once.
    expect(ids({ kind: 'union', left: query('role', 'button'), right: query('role', 'cell') }, table)).toEqual(['c1', 'c2', 'b2', 'c3']);
  });

  it('hands a selector inside has only the descendants of each candidate', () => {
    const seen: string[][] = [];
    const all = (_selector: string, candidates: readonly SemanticNode[]): readonly SemanticNode[] => {
      seen.push(candidates.map((candidate) => candidate.ref.id));
      return candidates;
    };
    const items = [node('a', { role: 'listitem', children: [node('a1', {})] }), node('b', { role: 'listitem' })];
    const expression: LocatorExpression = { kind: 'filter', source: query('role', 'listitem'), has: { kind: 'selector', selector: '*' } };
    expect(resolveExpression(expression, items, { selector: all }).map((match) => match.ref.id)).toEqual(['a']);
    expect(seen).toEqual([['a1'], []]);
  });

  it('rejects frames, since a semantic tree has no nested documents', () => {
    expect(() => ids({ kind: 'frame', selector: 'iframe', source: query('role', 'button') })).toThrowError(
      expect.objectContaining({ code: 'FRAME_NOT_FOUND', retryable: false }),
    );
  });
});
