/**
 * The built-in reporter ids, and the mark a built-in factory leaves on what
 * it returns. The mark grants nothing: `--reporter` only reads it to tell
 * the built-ins it may replace from the reporters it keeps, and config
 * resolution to treat a factory called without options as its id.
 */

import type { BuiltinReporter, Reporter } from '../run-types.ts';

/** A registered symbol, not a module-private one, since the config may import another copy of `e2e`. */
const BUILTIN_ID = Symbol.for('e2e.reporter.builtin');

export const BUILTIN_REPORTERS = ['list', 'dot', 'line', 'json', 'junit', 'markdown', 'ctrf'] as const satisfies readonly BuiltinReporter[];

export function isBuiltinReporter(value: string): value is BuiltinReporter {
  return (BUILTIN_REPORTERS as readonly string[]).includes(value);
}

/** What a built-in factory marks its reporter with. */
interface BuiltinMark {
  readonly id: BuiltinReporter;
  /** Called without the options its id depends on, so it is the id: `list()` prints to stderr beside `json`, as `'list'` does. */
  readonly asId: boolean;
  /** The terminal stream `list`, `dot`, or `line` was told to print to; absent for the others. */
  readonly stream?: 'stdout' | 'stderr';
}

/** Marks `reporter` as the built-in `id`; every built-in factory returns through this. */
export function builtin<R extends Reporter>(id: BuiltinReporter, reporter: R, asId = false, stream?: 'stdout' | 'stderr'): R {
  Object.defineProperty(reporter, BUILTIN_ID, { value: { id, asId, ...(stream === undefined ? {} : { stream }) } satisfies BuiltinMark });
  return reporter;
}

/** The mark a built-in factory left on `reporter`; undefined for any other reporter. */
export function builtinMark(reporter: Reporter): BuiltinMark | undefined {
  const mark: unknown = (reporter as { [BUILTIN_ID]?: unknown })[BUILTIN_ID];
  if (typeof mark !== 'object' || mark === null) return undefined;
  const { id, asId, stream } = mark as Partial<Record<keyof BuiltinMark, unknown>>;
  if (typeof id !== 'string' || !isBuiltinReporter(id)) return undefined;
  return { id, asId: asId === true, ...(stream === 'stdout' || stream === 'stderr' ? { stream } : {}) };
}

/** The built-in id a factory marked `reporter` with; undefined for any other reporter. */
export function builtinId(reporter: Reporter): BuiltinReporter | undefined {
  return builtinMark(reporter)?.id;
}
