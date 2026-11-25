/** Which module is evaluating when a registration call runs. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

/** `at name (location:line:column)` or `at location:line:column`, either one after `async`. */
const FRAME = /^at (?:async )?(?:[^(]*? \()?(.+?):\d+(?::\d+)?\)?$/;
/** A frame of Node.js's ES module loader: the frame before it is a module's top level, evaluating. */
const MODULE_LOADER = 'node:internal/modules/esm/';
/** How many frames `getCallSites` reads at most. */
const DIRECT_FRAMES = 200;

/**
 * The file of the module evaluating now, read off the stack: the frame the
 * ES module loader runs, or, once the module has awaited, the outermost
 * frame, as the awaiting callers of the running call end at the module.
 * A module that calls or awaits a function of another module is the one
 * evaluating, not the module of that function.
 *
 * The file is the one Node.js loaded, not the source a source map names
 * (a compiled helper's `.ts`): the loader knows its modules by the files it
 * loaded. So the stack is read with source maps off.
 *
 * Node.js only: the loader's frames are how a module's top level is told
 * from a function it calls.
 */
export function evaluatingModule(): string | undefined {
  const direct = runningModule();
  if (direct.loader) return direct.file;
  const mapped = process.sourceMapsEnabled;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  let stack: string;
  try {
    if (mapped) process.setSourceMapsEnabled(false);
    stack = new Error().stack ?? '';
  } finally {
    if (mapped) process.setSourceMapsEnabled(true);
    Error.stackTraceLimit = limit;
  }
  return outermostBeforeLoader(stack.split('\n').slice(1).flatMap((line) => FRAME.exec(line.trim())?.[1] ?? [])).file;
}

/**
 * The module whose top level is running the current call, when the loader's
 * frame is among the call's own frames: read without the text of a stack,
 * as most calls come straight from a module's top level. Without that
 * frame (`loader` false: the module awaited, or a timer runs the call)
 * nothing here says which module is evaluating.
 */
export function runningModule(): { readonly file: string | undefined; readonly loader: boolean } {
  return outermostBeforeLoader(util.getCallSites(DIRECT_FRAMES, { sourceMap: false }).map((site) => site.scriptName));
}

/** The file of the outermost of `locations`, innermost first, before a frame of the module loader, and whether there was such a frame. */
function outermostBeforeLoader(locations: readonly string[]): { readonly file: string | undefined; readonly loader: boolean } {
  let outermost: string | undefined;
  for (const location of locations) {
    if (location.startsWith(MODULE_LOADER)) return { file: outermost, loader: true };
    const file = location.startsWith('file:') ? fileURLToPath(location) : location;
    if (path.isAbsolute(file)) outermost = file;
  }
  return { file: outermost, loader: false };
}
