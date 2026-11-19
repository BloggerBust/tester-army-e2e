/**
 * The CLI and config resolver share these reporter IDs. Adding a built-in
 * ID without a terminal factory or a stateless reporter fails to compile,
 * so the runner cannot accept an ID it cannot construct.
 */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { jsonReporter } from './json.ts';
import { junitReporter } from './junit.ts';
import { markdownReporter } from './markdown.ts';

export const TERMINAL_REPORTERS = ['list', 'dot', 'line'] as const satisfies readonly BuiltinReporter[];
export type TerminalReporterId = (typeof TERMINAL_REPORTERS)[number];

export const BUILTIN_REPORTERS = [...TERMINAL_REPORTERS, 'json', 'junit', 'markdown'] as const satisfies readonly BuiltinReporter[];

/** Reporter names shown in invalid-reporter diagnostics. */
export const BUILTIN_REPORTER_LIST = `${BUILTIN_REPORTERS.slice(0, -1).join(', ')}, and ${BUILTIN_REPORTERS.at(-1)}`;

export const STATELESS_REPORTERS: Record<Exclude<BuiltinReporter, TerminalReporterId>, Reporter> = {
  json: jsonReporter,
  junit: junitReporter,
  markdown: markdownReporter,
};

export function isBuiltinReporter(value: string): value is BuiltinReporter {
  return (BUILTIN_REPORTERS as readonly string[]).includes(value);
}

/** Identifies IDs that have a per-run terminal renderer. */
export function isTerminalReporter(id: BuiltinReporter): id is TerminalReporterId {
  return (TERMINAL_REPORTERS as readonly BuiltinReporter[]).includes(id);
}
