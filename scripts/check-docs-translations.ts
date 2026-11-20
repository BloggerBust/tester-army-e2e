/**
 * Warns when a translated docs page drifted from the English page it
 * translates, or when a language's navigation labels miss a tab or group.
 *
 * Translations are best effort: English is the source of truth, and a
 * translation may lag behind it, since no contributor can be expected to
 * edit a language they do not speak. So drift is a warning, never a failure.
 *
 * A translation lives at `docs/<language>/<path>.mdx` beside the English
 * `docs/<path>.mdx`; the site serves it at `/docs/<language>/<path>` and
 * falls back to the English page where none exists. The site gives a
 * translated page's headings, tabs, and accordions the English page's ids by
 * position, so every `#anchor` and the language switcher land on the same
 * section in either language. That holds only while both pages have the same
 * outline (a page whose outline differs keeps ids of its own), so this script
 * compares, outside code fences: the heading levels (h1 to h4, the ones with
 * ids) in order, the `<Tab>` and `<Accordion>` elements in order with the
 * `id` each carries, and the explicit `id="..."` values. It also compares the
 * code blocks, in order: a translation shows the English page's code, which
 * `check-docs-examples.ts` checks on the English page only. A missing
 * navigation label falls back to the English one on the site.
 *
 * It fails only on what needs no language to fix: a translation with no
 * English page (delete or move it with its English page), a translation
 * without a `title`, and a language with no `navigation.json`.
 *
 * Usage: `node scripts/check-docs-translations.ts`, part of `pnpm docs:check`.
 * Prints every warning (as an annotation on GitHub Actions) and exits 1
 * listing every problem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_LANGUAGES } from './docs-languages.ts';
import { pages } from './docs-pages.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
// MDX components can contain fences indented beyond CommonMark's three spaces.
const FENCE = /^ *(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,4})\s+\S/;
const ELEMENT = /<(Tab|Accordion)\b([^>]*)>/g;
const ID = /\bid="([^"]*)"/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

interface DocsJson {
  navigation: { tabs: { tab: string; groups?: { group: string }[] }[] };
}

interface Navigation {
  tabs?: Record<string, string>;
  groups?: Record<string, string>;
}

/** A docs path relative to `docs/`, with `/` separators on every OS. */
function docsPath(path: string): string {
  return relative(DOCS, path).split(sep).join('/');
}

/** A page's source with LF line endings, so the patterns match a CRLF checkout too. */
function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/**
 * The page's lines outside code fences, and its code blocks with their fence
 * lines; a fence closes only on the same character at least as long.
 */
function split(source: string): { prose: string[]; code: string[] } {
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
    } else {
      prose.push(line);
    }
  }
  return { prose, code };
}

/** What gives a page its anchors, in order (heading levels, tabs and accordions, explicit ids), and its code. */
function outline(source: string): { headings: string[]; elements: string[]; ids: string[]; code: string[] } {
  const { prose: lines, code } = split(source.replace(FRONTMATTER, ''));
  const text = lines.join('\n');
  return {
    headings: lines.flatMap((line) => {
      const heading = HEADING.exec(line);
      return heading ? [`h${heading[1]!.length}`] : [];
    }),
    elements: [...text.matchAll(ELEMENT)].map((match) => {
      const id = /\bid="([^"]*)"/.exec(match[2]!)?.[1];
      return id === undefined ? match[1]! : `${match[1]!}#${id}`;
    }),
    ids: [...text.matchAll(ID)].map((match) => match[1]!),
    code,
  };
}

/** The first position two lists differ at, described for the report, or undefined when they match. */
function difference(kind: string, english: string[], translated: string[]): string | undefined {
  const index = english.findIndex((item, i) => item !== translated[i]);
  const at = index === -1 ? (english.length === translated.length ? -1 : english.length) : index;
  if (at === -1) return undefined;
  return `${kind} #${at + 1} is ${translated[at] ?? 'missing'}, the English page has ${english[at] ?? 'none'} (${english.length} vs ${translated.length} in all)`;
}

const problems: string[] = [];
const warnings: { file: string; message: string }[] = [];
const config = JSON.parse(read(join(DOCS, 'docs.json'))) as DocsJson;
let checked = 0;

for (const language of DOCS_LANGUAGES) {
  const root = join(DOCS, language);
  for (const page of pages(root)) {
    const file = docsPath(page);
    const english = join(DOCS, relative(root, page));
    if (!existsSync(english)) {
      problems.push(`docs/${file}: no English page at docs/${docsPath(english)} to translate`);
      continue;
    }
    const source = read(page);
    if (!/^title:\s*\S/m.exec(FRONTMATTER.exec(source)?.[1] ?? '')) {
      problems.push(`docs/${file}: the frontmatter has no title`);
    }
    const ours = outline(source);
    const theirs = outline(read(english));
    for (const problem of [
      difference('heading', theirs.headings, ours.headings),
      difference('<Tab>/<Accordion>', theirs.elements, ours.elements),
      difference('id', theirs.ids, ours.ids),
    ]) {
      if (problem) {
        warnings.push({
          file: `docs/${file}`,
          message: `${problem}; until the outline matches, the site gives this page ids of its own, so links to its anchors and the language switcher miss`,
        });
      }
    }
    const drifted = theirs.code.findIndex((block, i) => block !== ours.code[i]);
    if (drifted !== -1 || theirs.code.length !== ours.code.length) {
      const at = drifted === -1 ? theirs.code.length : drifted;
      warnings.push({
        file: `docs/${file}`,
        message: `code block #${at + 1} differs from the English page's (${theirs.code.length} vs ${ours.code.length} in all)`,
      });
    }
    checked++;
  }

  const navigationFile = join(root, 'navigation.json');
  if (!existsSync(navigationFile)) {
    problems.push(`docs/${language}/navigation.json: missing; it labels the tabs and groups`);
    continue;
  }
  const navigation = JSON.parse(read(navigationFile)) as Navigation;
  const tabs = config.navigation.tabs.map((tab) => tab.tab);
  const groups = [...new Set(config.navigation.tabs.flatMap((tab) => (tab.groups ?? []).map((group) => group.group)))];
  for (const [kind, names, labels] of [
    ['tabs', tabs, navigation.tabs ?? {}],
    ['groups', groups, navigation.groups ?? {}],
  ] as const) {
    const file = `docs/${language}/navigation.json`;
    for (const name of names) {
      if (!labels[name]) warnings.push({ file, message: `no label in "${kind}" for "${name}"` });
    }
    for (const name of Object.keys(labels)) {
      if (!names.includes(name)) warnings.push({ file, message: `"${kind}" labels "${name}", which docs.json no longer has` });
    }
  }
}

if (warnings.length > 0) {
  const annotate = process.env['GITHUB_ACTIONS'] === 'true';
  const lines = warnings.map(({ file, message }) =>
    annotate ? `::warning file=${file}::Stale translation: ${message}` : `warning: ${file}: ${message}`,
  );
  process.stdout.write(
    `${lines.join('\n')}\n\ndocs translations: ${warnings.length} ${warnings.length === 1 ? 'place' : 'places'} behind English. Translations are best effort, so this does not fail the check; whoever updates the translation brings its outline, code, and labels in line. See authoring-docs, "Translations".\n`,
  );
}

if (problems.length > 0) {
  process.stderr.write(
    `${problems.join('\n')}\n\nA translation sits at the same path as its English page and has a title, and each language has a navigation.json. See authoring-docs, "Translations".\n`,
  );
  process.exitCode = 1;
} else {
  const behind = new Set(warnings.map(({ file }) => file).filter((file) => file.endsWith('.mdx'))).size;
  process.stdout.write(
    `docs translations: ${checked - behind} of ${checked} translated ${checked === 1 ? 'page matches its' : 'pages match their'} English outline and code\n`,
  );
}
