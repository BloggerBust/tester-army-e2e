/**
 * Failure-location presentation: finds the user's failing line in a stack and
 * renders a small annotated code frame around it, in vitest's frame style.
 * Generic over reporters; the list reporter is simply its first consumer.
 */

import { readFileSync } from 'node:fs';
import { userFrame, type StackFrame } from '@e2e-dev/core/lib/internal/source';
import { processSecrets } from '@e2e-dev/core/lib/run/secrecy';
import { bounded, fitColumns, terminalColumns, visibleWidth, type Colors } from './format.ts';

export { userFrame, type StackFrame };

/** Lines of context on each side of the failing line. */
const FRAME_RANGE = 2;
/** A source line longer than this is minified output; the frame would be noise. */
const MAX_FRAME_LINE_CHARS = 200;

/**
 * Renders the failing line with two lines of context on each side and a
 * column caret, gutter-numbered like vitest (`  28| code`), each line clipped
 * to `maxChars` (by default what fits the terminal). A line is redacted
 * before it is clipped: a file can spell a secret or a provider key out, and
 * half of one is no longer a match.
 */
export function codeFrame(frame: StackFrame, pc: Colors, maxChars = Math.max(20, terminalColumns() - 10)): string[] {
  let source: string;
  try {
    source = readFileSync(frame.file, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split(/\r?\n/);
  const index = frame.line - 1;
  if (index < 0 || index >= lines.length) return [];
  const start = Math.max(0, index - FRAME_RANGE);
  const end = Math.min(lines.length - 1, index + FRAME_RANGE);
  const gutter = (no: number | '' = ''): string => pc.gray(`${String(no).padStart(3)}|`);
  const rows: string[] = [];
  for (let i = start; i <= end; i += 1) {
    const line = lines[i] ?? '';
    const redacted = processSecrets.redact(line);
    const raw = bounded(redacted);
    if (raw.length > MAX_FRAME_LINE_CHARS) return [];
    const text = fitColumns(raw.trimEnd(), maxChars);
    rows.push(`${gutter(i + 1)}${text === '' ? '' : ` ${text}`}`);
    if (i === index) {
      const offset = Math.max(0, frame.column - 1);
      const prefix = processSecrets.redact(line.slice(0, offset));
      // If redacting at the split changes the result, the caret would point
      // into a replacement whose display width no longer maps to the source.
      if (redacted !== line && redacted !== prefix + processSecrets.redact(line.slice(offset))) continue;
      const column = visibleWidth(bounded(prefix));
      // A clipped-away location has no visible token to annotate.
      const limit = text === raw.trimEnd() ? maxChars : visibleWidth(text) - 1;
      if (column < limit) {
        rows.push(`${gutter()}${' '.repeat(column + 1)}${pc.red('^')}`);
      }
    }
  }
  return rows;
}
