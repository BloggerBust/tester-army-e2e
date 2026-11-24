/**
 * `e2e/reporters`: the reporters the runner ships, as factories on the same
 * public `Reporter` contract a project's own reporters implement. An id in
 * `reporters` (`'junit'`) is its factory called with no options (`junit()`);
 * call the factory to pass options:
 *
 * ```ts
 * import { junit, list } from 'e2e/reporters';
 * export default defineConfig({ targets, reporters: [list(), junit({ outputFile: 'reports/junit.xml' })] });
 * ```
 */

export { ctrf, type CtrfReporterOptions } from './report/ctrf.ts';
export { dot, type DotReporterOptions } from './report/dot.ts';
export { json } from './report/json.ts';
export { junit, type JunitReporterOptions } from './report/junit.ts';
export { line, type LineReporterOptions } from './report/line.ts';
export { list, type ListReporterOptions } from './report/list.ts';
export { markdown, type MarkdownReporterOptions } from './report/markdown.ts';
