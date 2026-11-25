/** Parallel scopes: which tests of one file may run at the same time on separate workers. */

import { describeValue } from '@e2e-dev/core/lib/config/validate';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { unknownKeyMessage } from '@e2e-dev/core/lib/internal/options';
import type { GroupNode, ModuleRegistration } from './registry.ts';

/**
 * Checks a `parallel` value about to be set on a scope: the file, or a group
 * whose `serial` is given.
 */
export function checkParallel(api: string, value: unknown, serial: boolean): asserts value is boolean | undefined {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    throw new CollectionError(`${api}: parallel must be true or false, got ${describeValue(value)}`);
  }
  if (serial) {
    throw new CollectionError(`${api}: parallel cannot be set on a serial group, which runs as one unit on one worker`);
  }
}

/**
 * The `parallel` a `describe.configure()` call sets on its scope, which has
 * `current` so far and is a serial group or not; undefined when the call
 * sets none.
 */
export function configuredParallel(options: unknown, current: boolean | undefined, serial: boolean): boolean | undefined {
  const api = 'describe.configure()';
  if (typeof options !== 'object' || options === null) throw new CollectionError(`${api} takes an options object, e.g. { parallel: true }`);
  if ('mode' in options) {
    throw new CollectionError(`${api} takes no mode: use { parallel: true } for 'parallel', { parallel: false } for 'default', and describe(title, { serial: true }, fn) for 'serial'`);
  }
  const unknown = unknownKeyMessage(api, options, ['parallel']);
  if (unknown !== undefined) throw new CollectionError(unknown);
  const { parallel } = options as { parallel?: unknown };
  checkParallel(api, parallel, serial);
  if (parallel !== undefined && current !== undefined) throw new CollectionError(`${api}: parallel is already set for this scope`);
  return parallel;
}

/**
 * Refuses a parallel group inside a scope that runs in order, as the tests
 * of a serial group or a `parallel: false` scope stay on one worker. Checked
 * once the file has registered, since `describe.configure()` may set a
 * scope's `parallel` after the groups inside it were declared.
 */
export function checkParallelNesting(groups: readonly GroupNode[], fileParallel: boolean | undefined): void {
  for (const group of groups) {
    if (group.parallel !== true) continue;
    const around: GroupNode[] = [];
    for (let parent = group.parent; parent !== undefined; parent = parent.parent) around.push(parent);
    const where = `describe ${JSON.stringify(group.title)}`;
    if (around.some((parent) => parent.serial)) {
      throw new CollectionError(`${where}: parallel: true cannot be set inside a serial group, which runs as one unit on one worker`);
    }
    if (fileParallel === false || around.some((parent) => parent.parallel === false)) {
      throw new CollectionError(`${where}: parallel: true cannot be set inside a scope with parallel: false, which runs in order on one worker`);
    }
  }
}

/** Where a test sits among its file's parallel scopes. */
export interface ParallelPlacement {
  /**
   * Whether a scope around the test, a group or the file, has `parallel: true`.
   * For a test in an `ordered` scope, whether that holds for every test of
   * the scope: the scope runs as one unit, in the file's own when one of its
   * tests is in no parallel scope.
   */
  readonly declared: boolean;
  /**
   * The outermost scope around the test that runs in order on one worker, a
   * serial group or a scope with `parallel: false`, by a name of its own
   * within the file; undefined when no such scope is around it. Serial
   * groups with one title path share a name, as they share the serial group
   * id their records carry: one unit runs them, so the id stays one record,
   * and the `parallel: false` scopes around them share that name with them.
   */
  readonly ordered: string | undefined;
  /** Whether a scope around the test has a `beforeAll` or `afterAll` hook. */
  readonly suiteHooks: boolean;
}

/**
 * The scopes that keep a test on one worker, from the groups around it,
 * outermost first: the outermost group that runs in order, and the outermost
 * serial group by its title path, which is its serial group id.
 */
function orderedScopes(groups: readonly GroupNode[]): (GroupNode | string)[] {
  const ordered = groups.find((group) => group.serial || group.parallel === false);
  const serialAt = groups.findIndex((group) => group.serial);
  const serial = serialAt === -1 ? undefined : JSON.stringify(groups.slice(0, serialAt + 1).map((group) => group.title));
  return [ordered, serial].filter((scope) => scope !== undefined);
}

function groupsAround(group: GroupNode | undefined): GroupNode[] {
  const groups: GroupNode[] = [];
  for (let around = group; around !== undefined; around = around.parent) groups.unshift(around);
  return groups;
}

/** The placement of each test of one registration, from the groups around the test, outermost first. */
export function parallelPlacements(registration: ModuleRegistration): (groups: readonly GroupNode[]) => ParallelPlacement {
  const hooked = new Set(
    registration.hooks.filter((hook) => hook.kind === 'beforeAll' || hook.kind === 'afterAll').map((hook) => hook.group),
  );
  // Scopes that share a test share a unit: two `parallel: false` groups whose serial groups have one id are one.
  const merged = new Map<GroupNode | string, GroupNode | string>();
  const unitOf = (scope: GroupNode | string): GroupNode | string => {
    const next = merged.get(scope);
    return next === undefined ? scope : unitOf(next);
  };
  const declaredIn = (groups: readonly GroupNode[]): boolean => registration.parallel === true || groups.some((group) => group.parallel === true);
  const inOrder = new Set<GroupNode | string>();
  for (const test of registration.tests) {
    const groups = groupsAround(test.group);
    const [first, ...rest] = orderedScopes(groups).map(unitOf);
    for (const scope of rest) {
      if (scope === first) continue;
      merged.set(scope, first!);
      if (inOrder.has(scope)) inOrder.add(first!);
    }
    if (first !== undefined && !declaredIn(groups)) inOrder.add(first);
  }
  const names = new Map<GroupNode | string, string>();
  const nameOf = (scope: GroupNode | string): string => {
    let name = names.get(scope);
    if (name === undefined) {
      name = `group-${names.size}`;
      names.set(scope, name);
    }
    return name;
  };
  return (groups) => {
    const [scope] = orderedScopes(groups);
    const unit = scope === undefined ? undefined : unitOf(scope);
    return {
      declared: unit === undefined ? declaredIn(groups) : !inOrder.has(unit),
      ordered: registration.parallel === false ? 'file' : unit === undefined ? undefined : nameOf(unit),
      suiteHooks: hooked.has(undefined) || groups.some((group) => hooked.has(group)),
    };
  };
}
