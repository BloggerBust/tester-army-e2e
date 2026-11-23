/**
 * The reference locator semantics over a semantic tree: what `locate`
 * answers for one `LocatorExpression` when the platform's tree is the whole
 * truth. An engine over such a tree (a device's accessibility snapshot, an
 * in-memory fake) calls this instead of interpreting the expression itself;
 * an engine with a native query engine (a browser) reproduces these rules.
 * One immediate pass, every match in document order; polling, strictness,
 * and staleness stay with the runner.
 */

import { compileTextMatcher } from '../internal/text.ts';
import {
  EngineError,
  type LocatorExpression,
  type SemanticNode,
  type SemanticQuery,
} from './contract.ts';

export interface ResolveExpressionOptions {
  /**
   * Answers a `selector` expression: the nodes the platform-native selector
   * addresses among `candidates`, in document order. Without it a selector
   * is `UNSUPPORTED_CAPABILITY`, since a semantic tree has no selector
   * language of its own.
   */
  readonly selector?: (selector: string, candidates: readonly SemanticNode[]) => readonly SemanticNode[];
}

/**
 * Resolves one expression to the nodes it currently matches, in document
 * order. `nodes` are the tree's top-level nodes (an observation root's
 * children, or the root itself); every node under them is a candidate.
 *
 * Query kinds: `role` compares the role exactly, then the name, the requested
 * states, and the heading level, and never matches a hidden node; `label`
 * and `text` match the name (`text` the visible text too) and answer with
 * the innermost match, since a container echoing a descendant's text is not
 * a second match; `placeholder`, `displayValue`, and `testId` compare their
 * one field. `visible` drops hidden nodes from any kind. `scope` searches
 * strict descendants of the scope's matches; `filter` keeps a match whose
 * own or descendants' name, text, or value matches `hasText`, and whose
 * descendants answer `has`; `index` picks `first`, `last`, or a position.
 * `frame` is `FRAME_NOT_FOUND`: a semantic tree has no nested documents.
 */
export function resolveExpression(
  expression: LocatorExpression,
  nodes: readonly SemanticNode[],
  options: ResolveExpressionOptions = {},
): SemanticNode[] {
  const tree = indexTree(nodes);
  return resolve(expression, { start: 0, end: tree.all.length }, tree, options);
}

/**
 * Every node of a tree in document (DFS pre-order) order, with the index
 * range of each node's subtree: `all[enter]` is the node itself and
 * `all[start .. end)` its descendants (`start` is `enter + 1`), so
 * containment is an interval test rather than a walk up the parents.
 */
interface TreeIndex {
  readonly all: readonly SemanticNode[];
  readonly subtrees: ReadonlyMap<SemanticNode, Range & { readonly enter: number }>;
}

/** A half-open `[start, end)` range of `TreeIndex.all`. */
interface Range {
  readonly start: number;
  readonly end: number;
}

function indexTree(roots: readonly SemanticNode[]): TreeIndex {
  const all: SemanticNode[] = [];
  const subtrees = new Map<SemanticNode, Range & { readonly enter: number }>();
  const walk = (node: SemanticNode): void => {
    const enter = all.length;
    all.push(node);
    for (const child of node.children ?? []) walk(child);
    subtrees.set(node, { enter, start: enter + 1, end: all.length });
  };
  for (const root of roots) walk(root);
  return { all, subtrees };
}

/**
 * Resolves `expression` among the candidates `tree.all[within]`. The
 * candidates are always one contiguous range: the whole tree, or the
 * descendants of one `filter` match (a subtree within a range is a range).
 */
function resolve(
  expression: LocatorExpression,
  within: Range,
  tree: TreeIndex,
  options: ResolveExpressionOptions,
): SemanticNode[] {
  switch (expression.kind) {
    case 'union': {
      const left = resolve(expression.left, within, tree, options);
      const right = resolve(expression.right, within, tree, options);
      if (left.length === 0 && right.length === 0) return [];
      const matches = new Set([...left, ...right]);
      return tree.all.slice(within.start, within.end).filter((node) => matches.has(node));
    }
    case 'query': {
      const matches: SemanticNode[] = [];
      const pool =
        expression.scope === undefined
          ? [within]
          : descendantRanges(resolve(expression.scope, within, tree, options), within, tree);
      const matchesQuery = compileQueryMatcher(expression.query);
      for (const { start, end } of pool) {
        for (let index = start; index < end; index += 1) {
          const node = tree.all[index]!;
          if (matchesQuery(node)) matches.push(node);
        }
      }
      return INNERMOST_KINDS.has(expression.query.kind) ? innermostOnly(matches, tree) : matches;
    }
    case 'filter': {
      const source = resolve(expression.source, within, tree, options);
      const hasText = expression.hasText === undefined ? undefined : compileTextMatcher(expression.hasText);
      const hasNotText = expression.hasNotText === undefined ? undefined : compileTextMatcher(expression.hasNotText);
      return source.filter((node) => {
        if (hasText !== undefined && !subtreeHasText(node, within, tree, hasText)) return false;
        if (hasNotText !== undefined && subtreeHasText(node, within, tree, hasNotText)) return false;
        if (expression.has !== undefined || expression.hasNot !== undefined) {
          const inside = descendantRange(node, within, tree);
          if (expression.has !== undefined && resolve(expression.has, inside, tree, options).length === 0) return false;
          if (expression.hasNot !== undefined && resolve(expression.hasNot, inside, tree, options).length > 0) return false;
        }
        return true;
      });
    }
    case 'index': {
      const source = resolve(expression.source, within, tree, options);
      const position =
        expression.index === 'first' ? 0 : expression.index === 'last' ? source.length - 1 : expression.index;
      const picked = source[position];
      return picked === undefined ? [] : [picked];
    }
    case 'selector': {
      if (options.selector === undefined) {
        throw new EngineError(
          'UNSUPPORTED_CAPABILITY',
          `selector ${JSON.stringify(expression.selector)} needs a platform selector language, and this surface has none`,
          { retryable: false },
        );
      }
      return [...options.selector(expression.selector, tree.all.slice(within.start, within.end))];
    }
    case 'frame':
      throw new EngineError(
        'FRAME_NOT_FOUND',
        `no nested document matches ${JSON.stringify(expression.selector)}: this surface has none to scope a query into`,
        { retryable: false },
      );
  }
}

/** The query kinds a container answers for its descendants, so only the innermost match counts. */
const INNERMOST_KINDS: ReadonlySet<SemanticQuery['kind']> = new Set(['text', 'label']);

/**
 * Drops every match that contains another match, the way a browser's text
 * selector answers with the innermost element. A device tree echoes text
 * upwards: iOS reports a React Native Text host view and its StaticText child
 * with the same label, and a container view inherits its descendants' labels,
 * so without this rule every `getByText` on such a screen is ambiguous.
 *
 * `matches` is in document order with no repeats, so a match contains another
 * exactly when it contains the next one: every later match it contains comes
 * after the next one and before its subtree ends.
 */
function innermostOnly(matches: readonly SemanticNode[], tree: TreeIndex): SemanticNode[] {
  return matches.filter((node, index) => {
    const next = matches[index + 1];
    return next === undefined || !contains(node, next, tree);
  });
}

/** True when `node` is a strict descendant of `ancestor`. */
function contains(ancestor: SemanticNode, node: SemanticNode, tree: TreeIndex): boolean {
  const outer = tree.subtrees.get(ancestor);
  const inner = tree.subtrees.get(node);
  return outer !== undefined && inner !== undefined && inner.enter >= outer.start && inner.enter < outer.end;
}

/**
 * The candidates in `within` that are strict descendants of `ancestor`. A
 * node from outside the tree (a selector hook may answer one) has none.
 */
function descendantRange(ancestor: SemanticNode, within: Range, tree: TreeIndex): Range {
  const subtree = tree.subtrees.get(ancestor);
  if (subtree === undefined) return { start: within.end, end: within.end };
  const start = Math.max(within.start, subtree.start);
  return { start, end: Math.max(start, Math.min(within.end, subtree.end)) };
}

/**
 * The candidates in `within` that are strict descendants of any node in
 * `ancestors`, as disjoint ranges in document order: nested and repeated
 * ancestors merge, so each candidate is in one range at most.
 */
function descendantRanges(ancestors: readonly SemanticNode[], within: Range, tree: TreeIndex): Range[] {
  const ranges = ancestors
    .map((ancestor) => descendantRange(ancestor, within, tree))
    .filter(({ start, end }) => start < end)
    .toSorted((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Whether the node's own name, text, or value, or a descendant's within `within`, matches. */
function subtreeHasText(
  node: SemanticNode,
  within: Range,
  tree: TreeIndex,
  matches: (text: string) => boolean,
): boolean {
  const matchesAny = (entry: SemanticNode): boolean =>
    (entry.name !== undefined && matches(entry.name)) ||
    (entry.text !== undefined && matches(entry.text)) ||
    (entry.value !== undefined && matches(entry.value));
  if (matchesAny(node)) return true;
  const { start, end } = descendantRange(node, within, tree);
  for (let index = start; index < end; index += 1) {
    if (matchesAny(tree.all[index]!)) return true;
  }
  return false;
}

/** The states a role query may require, in contract order. */
const STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded', 'pressed'] as const satisfies readonly (keyof NonNullable<
  SemanticQuery['states']
>)[];

/**
 * Compiles one semantic query to a test of one node, its text patterns
 * compiled once per pass over the candidates rather than once per node. Role queries skip hidden nodes, as a
 * browser's role query does; the other kinds answer with every node and
 * leave visibility to the action or assertion, unless the query says
 * `visible`, which drops hidden nodes for every kind.
 */
function compileQueryMatcher(query: SemanticQuery): (node: SemanticNode) => boolean {
  const matches = compileKindMatcher(query);
  return query.visible === true ? (node) => node.states?.hidden !== true && matches(node) : matches;
}

function compileKindMatcher(query: SemanticQuery): (node: SemanticNode) => boolean {
  switch (query.kind) {
    case 'role': {
      const role = query.value;
      // Thrown when a node is tested, not here, so a query over no candidates answers nothing.
      if (role.kind !== 'string') {
        return () => {
          throw new EngineError('ENGINE_FAILURE', 'role query value must be a string', { retryable: false });
        };
      }
      const name = query.name === undefined ? undefined : compileTextMatcher(query.name);
      const wanted = query.states ?? {};
      return (node) => {
        if ((node.role ?? '') !== role.value) return false;
        if (name !== undefined && !name(node.name ?? '')) return false;
        if (node.states?.hidden === true) return false;
        for (const key of STATE_KEYS) {
          const expected = wanted[key];
          if (expected !== undefined && (node.states?.[key] ?? false) !== expected) return false;
        }
        // A tree without heading levels answers a level query with nothing rather than everything.
        return query.level === undefined || node.level === query.level;
      };
    }
    case 'label': {
      const matches = compileTextMatcher(query.value);
      return (node) => node.name !== undefined && matches(node.name);
    }
    case 'placeholder': {
      const matches = compileTextMatcher(query.value);
      return (node) => {
        const placeholder = node.attributes?.['placeholder'];
        return placeholder !== undefined && matches(placeholder);
      };
    }
    case 'text': {
      const matches = compileTextMatcher(query.value);
      return (node) => (node.name !== undefined && matches(node.name)) || (node.text !== undefined && matches(node.text));
    }
    case 'displayValue': {
      const matches = compileTextMatcher(query.value);
      return (node) => node.value !== undefined && matches(node.value);
    }
    case 'testId': {
      const matches = compileTextMatcher(query.value);
      return (node) => node.testId !== undefined && matches(node.testId);
    }
  }
}
