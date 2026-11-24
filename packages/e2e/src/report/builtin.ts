/**
 * The reporters the runner ships, by id. Each is a factory on the public
 * `Reporter` contract (`e2e/reporters`), and an id in `reporters` or
 * `--reporter` is that factory called with no options. Adding an id here
 * without a factory in the map fails to compile, so the config resolver, the
 * CLI, and the runner cannot drift apart on what the ids are.
 */

import type { BuiltinReporter, Reporter } from '../run-types.ts';
import { BUILTIN_REPORTERS } from './builtin-id.ts';
import { ctrf } from './ctrf.ts';
import { dot } from './dot.ts';
import { json } from './json.ts';
import { junit } from './junit.ts';
import { line } from './line.ts';
import { list } from './list.ts';
import { markdown } from './markdown.ts';

/** The ids as prose: `list, dot, line, json, junit, markdown, and ctrf`. */
export const BUILTIN_REPORTER_LIST = `${BUILTIN_REPORTERS.slice(0, -1).join(', ')}, and ${BUILTIN_REPORTERS.at(-1)}`;

type Stream = 'stdout' | 'stderr';

const FACTORIES: Record<BuiltinReporter, (stream: Stream) => Reporter> = {
  list: (stream) => list({ stream }),
  dot: (stream) => dot({ stream }),
  line: (stream) => line({ stream }),
  json: () => json(),
  junit: () => junit(),
  markdown: () => markdown(),
  ctrf: () => ctrf(),
};

/** The built-in `id` with its default options; `list`, `dot`, and `line` print to `stream`. */
export function builtinReporter(id: BuiltinReporter, stream: Stream = 'stdout'): Reporter {
  return FACTORIES[id](stream);
}
