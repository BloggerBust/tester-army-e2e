/**
 * The CLI and config resolver share these reporter IDs. Terminal reporters
 * are created for each run, while the typed map below requires an
 * implementation for every other ID.
 */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { jsonReporter } from './json.ts';
import { junitReporter } from './junit.ts';
import { markdownReporter } from './markdown.ts';

export const BUILTIN_REPORTERS = ['list', 'dot', 'line', 'json', 'junit', 'markdown'] as const satisfies readonly BuiltinReporter[];

/** Reporter names shown in invalid-reporter diagnostics. */
export const BUILTIN_REPORTER_LIST = `${BUILTIN_REPORTERS.slice(0, -1).join(', ')}, and ${BUILTIN_REPORTERS.at(-1)}`;

export const STATELESS_REPORTERS: Record<Exclude<BuiltinReporter, 'list' | 'dot' | 'line'>, Reporter> = {
  json: jsonReporter,
  junit: junitReporter,
  markdown: markdownReporter,
};

export function isBuiltinReporter(value: string): value is BuiltinReporter {
  return (BUILTIN_REPORTERS as readonly string[]).includes(value);
}
