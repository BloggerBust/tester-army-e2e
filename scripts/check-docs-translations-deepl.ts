/**
 * Checks the translated docs against DeepL, section by section
 * (`deepl-review.ts`): each section of a `docs/ja/<path>.mdx` page is
 * translated back into English and compared with the same section of
 * `docs/<path>.mdx`, and compared with DeepL's own Japanese for the English.
 * A section far from DeepL in both directions, left in English, or missing a
 * glossary term DeepL used gets a warning on its heading and a row in the job
 * summary, with both of DeepL's versions so a reviewer can judge it. The
 * check never fails on a flag: DeepL is a second opinion, not the source of
 * truth. It fails only when DeepL cannot be reached. When DeepL's monthly
 * quota is used up, the review goes on with openai/gpt-6-luna on the Vercel
 * AI Gateway, or skips with a warning without AI_GATEWAY_API_KEY.
 *
 * Sections pair by position, which holds only while a translation keeps its
 * English page's outline. Translations are best effort and may lag behind,
 * so a page whose outline differs is skipped here with a notice;
 * `check-docs-translations.ts` warns about it.
 *
 * The docs workflow's `translations` job runs it on pull requests that touch the docs.
 *
 * Usage: `node scripts/check-docs-translations-deepl.ts [--base <ref>] [--report <file>]`.
 * With `--base`, only the sections whose English or Japanese text differs
 * from `<ref>` are sent to DeepL, so an English edit that leaves its
 * translation stale is checked too, unless it changed the outline. Without it every section is sent: about
 * a million characters for the whole docs, twice the Free plan's month.
 * `--report` also writes every reviewed section, with DeepL's versions and
 * the scores, to `<file>` as JSON.
 *
 * Environment:
 *   DEEPL_API_KEY        a DeepL API key; a Free key (ending in :fx) uses
 *                        api-free.deepl.com. Without one the check skips, as on
 *                        a fork's pull request.
 *   AI_GATEWAY_API_KEY   the Vercel AI Gateway key for the fallback
 *   GITHUB_STEP_SUMMARY  where the report goes in CI
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  deepl,
  gateway,
  type Pair,
  parseGlossary,
  QuotaExceeded,
  review,
  sections,
  withFallback,
} from './deepl-review.ts';
import { pages } from './docs-pages.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const LANGUAGE = 'ja';

const { values } = parseArgs({ options: { base: { type: 'string' }, report: { type: 'string' } } });
const key = process.env['DEEPL_API_KEY'];
if (!key) {
  process.stdout.write('::notice::docs translations: DEEPL_API_KEY is not set, skipping the DeepL review\n');
  process.exit(0);
}

/** A path relative to the repository root, with `/` separators on every OS. */
function repoPath(path: string): string {
  return relative(ROOT, path).split(sep).join('/');
}

/** A file's text at the base ref, or undefined where it did not exist yet. */
function atBase(path: string): string | undefined {
  if (!values.base) return undefined;
  try {
    return execFileSync('git', ['show', `${values.base}:${repoPath(path)}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

const pairs: (Pair & { file: string; line: number })[] = [];
const skipped: string[] = [];
for (const page of pages(join(DOCS, LANGUAGE))) {
  const english = join(DOCS, relative(join(DOCS, LANGUAGE), page));
  if (!existsSync(english)) continue;
  const file = repoPath(page);
  const ours = sections(readFileSync(page, 'utf8'));
  const theirs = sections(readFileSync(english, 'utf8'));
  if (ours.length !== theirs.length) {
    skipped.push(`${file}: ${ours.length} sections, the English page has ${theirs.length}`);
    continue;
  }
  const baseOurs = atBase(page);
  const baseTheirs = atBase(english);
  const before = baseOurs !== undefined && baseTheirs !== undefined ? [sections(baseOurs), sections(baseTheirs)] : undefined;
  theirs.forEach((section, i) => {
    const ja = ours[i]!;
    if (!section.text || !ja.text) return;
    if (values.base && before?.[0]?.[i]?.text === ja.text && before[1]?.[i]?.text === section.text) return;
    pairs.push({ id: `${file} § ${section.heading}`, en: section.text, ja: ja.text, file, line: ja.line });
  });
}

const glossaryFile = join(DOCS, LANGUAGE, 'README.md');
const glossary = existsSync(glossaryFile) ? parseGlossary(readFileSync(glossaryFile, 'utf8')) : [];
const deeplTranslator = deepl(key, glossary);
const gatewayKey = process.env['AI_GATEWAY_API_KEY'];
const translator = withFallback(deeplTranslator, gatewayKey ? gateway(gatewayKey, glossary) : undefined);
let reviews: Awaited<ReturnType<typeof review>>;
try {
  reviews = await review(pairs, translator, glossary);
} catch (error) {
  if (!(error instanceof QuotaExceeded)) throw error;
  process.stdout.write(
    `::warning::docs translations: ${pairs.length} changed sections not reviewed: ${error.message}, and AI_GATEWAY_API_KEY is not set for the fallback. Re-run the job after the quota resets.\n`,
  );
  process.exit(0);
}
if (values.report) writeFileSync(values.report, `${JSON.stringify(reviews, null, 2)}\n`);
const by = translator.name;
const usage = await deeplTranslator.usage();
const usageLine =
  `DeepL usage this month: ${usage.count.toLocaleString('en')} of ${usage.limit.toLocaleString('en')} characters.` +
  (by === 'DeepL' ? '' : ` The quota ran out, so ${by} translated instead.`);
if (by !== 'DeepL') process.stdout.write(`::notice::docs translations: DeepL's quota is used up, ${by} translated instead\n`);
const flagged = reviews.filter((entry) => entry.problems.length > 0);

const escape = (text: string) => text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
const property = (text: string) => escape(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
for (const message of skipped) {
  process.stdout.write(`::notice::docs translations: skipped ${escape(message)}\n`);
}
reviews.forEach((entry, i) => {
  if (entry.problems.length === 0) return;
  const { file, line } = pairs[i]!;
  process.stdout.write(
    `::warning file=${file},line=${line},title=${property(`${by}: ${entry.problems.join('; ')}`)}::` +
      `${escape(`${by}'s English for this section: ${entry.back}`)}\n`,
  );
});

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const score = (n: number) => n.toFixed(2);
const details = (entry: (typeof reviews)[number]) =>
  [
    `<details><summary><code>${entry.id}</code>: ${entry.problems.join('; ') || 'ok'} (${score(entry.referenceScore)} / ${score(entry.backScore)})</summary>`,
    '',
    '| | |',
    '| --- | --- |',
    `| English | ${cell(entry.en)} |`,
    `| ${by}'s English for ours | ${cell(entry.back)} |`,
    `| Ours | ${cell(entry.ja)} |`,
    `| ${by}'s Japanese | ${cell(entry.reference)} |`,
    '',
    '</details>',
  ].join('\n');
const summary = [
  `## Japanese docs checked against ${by}`,
  '',
  `${reviews.length} ${reviews.length === 1 ? 'section' : 'sections'} checked, ${flagged.length} flagged${skipped.length > 0 ? `, ${skipped.length} ${skipped.length === 1 ? 'page' : 'pages'} skipped` : ''}.`,
  `Scores are chrF from 0 to 1: ours against ${by}'s Japanese, then the English against ${by}'s English for ours. A flag is a prompt to look, not a verdict.`,
  usageLine,
  '',
  ...flagged.map(details),
  ...reviews.filter((entry) => entry.problems.length === 0).map(details),
  '',
].join('\n');
if (process.env['GITHUB_STEP_SUMMARY']) appendFileSync(process.env['GITHUB_STEP_SUMMARY'], summary);
else process.stdout.write(summary);

process.stdout.write(`${usageLine}\n`);
process.stdout.write(
  `docs translations: ${reviews.length} ${reviews.length === 1 ? 'section' : 'sections'} checked against ${by}, ${flagged.length} flagged\n`,
);
