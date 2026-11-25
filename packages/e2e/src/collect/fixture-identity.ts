/** What a fixture definition is called across evaluations of the module that defines it. */

import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { onBun } from '../internal/runtime.ts';
import { runningModule } from './evaluating-module.ts';

/** How many definitions each name stands for so far, by collection. */
const counts = new WeakMap<object, Map<string, number>>();

/**
 * Names the fixtures one `test.extend()` call at `site` defines while
 * `collection` runs: the module evaluating, the call's place, the fixture's
 * name, and how many definitions that made before in this collection (a
 * helper that extends in a loop). A module that is evaluated again, a test
 * file after a failed test or a module that registers hooks with every file
 * that imports it, defines the same fixtures under the same names, so a
 * worker keeps one instance of each. The module evaluating is part of the
 * name because two test files that call one helper define two fixtures.
 *
 * A fixture has no name, and is its definition, where nothing says for sure
 * which module is evaluating: outside a collection, once the module has
 * awaited, and on Bun, whose stack does not show it.
 */
export function fixtureIdentities(collection: object | undefined, site: SourceLocation | undefined): (name: string) => string | undefined {
  if (collection === undefined || site === undefined || onBun) return () => undefined;
  const { file: evaluating, loader } = runningModule();
  if (!loader || evaluating === undefined) return () => undefined;
  const defined = counts.get(collection) ?? new Map<string, number>();
  counts.set(collection, defined);
  return (name) => {
    const base = [evaluating, site.file, site.line, site.column, name].join('\u0000');
    const index = defined.get(base) ?? 0;
    defined.set(base, index + 1);
    return `${base}\u0000${index}`;
  };
}
