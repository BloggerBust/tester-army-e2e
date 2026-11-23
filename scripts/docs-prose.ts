/**
 * How the docs checks read a page: its frontmatter, its prose apart from its
 * code, and the lines an edit left twice.
 */

// MDX components can contain fences indented beyond CommonMark's three spaces.
const FENCE = /^ *(`{3,}|~{3,})/;
// Shorter lines ("भी।", "नहीं।") can end the line above them by chance.
const MIN_REPEAT_LENGTH = 12;
// A line that is only a tag repeats on purpose, as nested `</Accordion>` lines do.
const TAG_ONLY = /^<\/?[A-Za-z][^<>]*>$/;

/** A page's frontmatter block; the first group is its body. */
export const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/**
 * The page's prose and its code blocks with their fence lines. The prose has
 * one entry per source line, a blank one for each line of a code block, so
 * an entry's index is its line and the prose on either side of a block stays
 * two paragraphs. A fence closes only on the same character, at least as
 * long.
 */
export function split(source: string): { prose: string[]; code: string[] } {
  const prose: string[] = [];
  const code: string[] = [];
  let open: { fence: string; lines: string[] } | undefined;
  for (const line of source.split('\n')) {
    const fence = FENCE.exec(line)?.[1];
    if (open) {
      open.lines.push(line);
      if (fence && fence[0] === open.fence[0] && fence.length >= open.fence.length && line.trim() === fence) {
        code.push(open.lines.join('\n'));
        open = undefined;
      }
    } else if (fence) {
      open = { fence, lines: [line] };
    }
    prose.push(open || fence ? '' : line);
  }
  return { prose, code };
}

/**
 * The lines of a page's prose that equal or end the line above them in the
 * same paragraph, with their 1-based line numbers. That is the trace of a
 * review suggestion anchored one line too high: it replaces the line above
 * the one it meant and leaves the old line's tail below the new text. No page
 * has one on purpose, so only the change that adds a repeat trips the check,
 * and its author can compare the paragraph with the English page. It cannot
 * see a deleted line, or a repeat that the suggestion reworded.
 */
export function repeatedLines(source: string): { line: number; text: string }[] {
  const frontmatter = FRONTMATTER.exec(source)?.[0] ?? '';
  const offset = frontmatter.split('\n').length - 1;
  const repeats: { line: number; text: string }[] = [];
  let above = '';
  for (const [index, raw] of split(source.slice(frontmatter.length)).prose.entries()) {
    const text = raw.trim();
    if (text.length >= MIN_REPEAT_LENGTH && !TAG_ONLY.test(text) && above.endsWith(text)) {
      repeats.push({ line: offset + index + 1, text });
    }
    above = text;
  }
  return repeats;
}
