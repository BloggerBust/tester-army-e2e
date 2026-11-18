/**
 * The reporters the runner ships, by id. `list` and `dot` render the terminal and are
 * constructed per run by the runner; the others are stateless objects on the
 * same `Reporter` contract. Adding an id here without a reporter in the map
 * fails to compile, so the config resolver, the CLI, and the runner cannot
 * drift apart on what the ids are.
 */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { jsonReporter } from './json.ts';
import { junitReporter } from './junit.ts';
import { markdownReporter } from './markdown.ts';

export const BUILTIN_REPORTERS = ['list', 'dot', 'json', 'junit', 'markdown'] as const satisfies readonly BuiltinReporter[];

/** The ids as prose: `list, dot, json, junit, and markdown`. */
export const BUILTIN_REPORTER_LIST = `${BUILTIN_REPORTERS.slice(0, -1).join(', ')}, and ${BUILTIN_REPORTERS.at(-1)}`;

export const STATELESS_REPORTERS: Record<Exclude<BuiltinReporter, 'list' | 'dot'>, Reporter> = {
  json: jsonReporter,
  junit: junitReporter,
  markdown: markdownReporter,
};

export function isBuiltinReporter(value: string): value is BuiltinReporter {
  return (BUILTIN_REPORTERS as readonly string[]).includes(value);
}
