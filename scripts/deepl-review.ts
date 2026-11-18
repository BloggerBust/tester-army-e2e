/**
 * Reviews translated docs text against DeepL, for `check-docs-translations-deepl.ts`.
 *
 * DeepL gives every English and Japanese pair a second opinion twice: it
 * translates the English into Japanese (the reference), and our Japanese
 * back into English. A pair is flagged when our Japanese is far from DeepL's
 * and the back-translation is far from the English, scored with chrF
 * (character n-gram F-score), which works for Japanese without a tokenizer. A
 * correct translation that only words things differently usually stays close
 * on one of the two; a wrong or stale one drifts on both.
 *
 * The glossary in `docs/ja/README.md` is uploaded as a DeepL glossary, so the
 * reference uses our terms, and a term DeepL's reference uses that ours does
 * not is flagged as well.
 *
 * When DeepL's monthly quota is used up, `withFallback` hands the
 * translations to a model on the Vercel AI Gateway (`gateway`), given the
 * same glossary in its prompt, and the review goes on unchanged.
 *
 * e2e-inc/e2e-site checks its UI copy the same way
 * (`apps/site/lib/i18n/deepl-review.ts`); keep the two in step.
 */

/**
 * Below this, on both scores, a pair is flagged. Set from the first run on the
 * UI copy: the one real mistranslation ("previous" as 前へ, which DeepL reads
 * as "Next") scored 0.11 at best, while rewordings such as ページ送り for
 * "pagination" scored up to 0.44.
 */
const THRESHOLD = 0.25;

export interface Pair {
  /** Where the pair lives, for the report. */
  id: string;
  en: string;
  ja: string;
}

export interface GlossaryEntry {
  en: string;
  ja: string;
}

export interface Translator {
  /** Who translates, for the report: "DeepL" or a model id. */
  readonly name: string;
  /** Translates every text, in order, from one language to the other. */
  translate(texts: string[], from: 'EN' | 'JA', to: 'EN' | 'JA'): Promise<string[]>;
}

/** DeepL's answer when the month's characters are used up. */
export class QuotaExceeded extends Error {}

export interface Usage {
  /** Characters translated this billing period. */
  count: number;
  /** The plan's characters per billing period. */
  limit: number;
}

export interface Review extends Pair {
  /** The translator's Japanese for the English. */
  reference: string;
  /** The translator's English for our Japanese. */
  back: string;
  /** chrF between our Japanese and DeepL's, 0 to 1. */
  referenceScore: number;
  /** chrF between the English and the back-translation, 0 to 1. */
  backScore: number;
  /** Why the pair is flagged; empty when it looks right. */
  problems: string[];
}

const JAPANESE = /[\u3040-\u30ff\u3400-\u9fff]/;

/** Text reduced to what chrF compares: NFKC, lowercase, no whitespace. */
function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function ngrams(text: string, n: number): Map<string, number> {
  const chars = [...text];
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= chars.length; i++) {
    const gram = chars.slice(i, i + n).join('');
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * chrF with n-grams of 1 to 6 characters and recall weighted twice (beta 2),
 * as in Popović (2015), from 0 (nothing shared) to 1 (identical).
 */
export function chrf(hypothesis: string, reference: string, maxN = 6, beta = 2): number {
  const hyp = normalize(hypothesis);
  const ref = normalize(reference);
  if (hyp === ref) return 1;
  if (!hyp || !ref) return 0;
  let precision = 0;
  let recall = 0;
  let orders = 0;
  for (let n = 1; n <= maxN; n++) {
    const h = ngrams(hyp, n);
    const r = ngrams(ref, n);
    if (h.size === 0 || r.size === 0) break;
    let shared = 0;
    let hTotal = 0;
    let rTotal = 0;
    for (const count of h.values()) hTotal += count;
    for (const [gram, count] of r) {
      rTotal += count;
      shared += Math.min(count, h.get(gram) ?? 0);
    }
    precision += shared / hTotal;
    recall += shared / rTotal;
    orders++;
  }
  precision /= orders;
  recall /= orders;
  if (precision === 0 && recall === 0) return 0;
  const b2 = beta * beta;
  return ((1 + b2) * precision * recall) / (b2 * precision + recall);
}

/**
 * The English to Japanese pairs in the glossary table of `docs/ja/README.md`,
 * the one two-column table. A row may pair several terms
 * ("test, test suite | テスト, テストスイート"), matched by position.
 */
export function parseGlossary(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of markdown.split('\n')) {
    const cells = /^\|(.*)\|\s*$/
      .exec(line)?.[1]
      ?.split('|')
      .map((cell) => cell.trim());
    if (cells?.length !== 2) continue;
    const [en = '', ja = ''] = cells;
    if (/^-+$/.test(en) || en.toLowerCase() === 'english') continue;
    const enTerms = en.split(',').map((term) => term.trim());
    const jaTerms = ja.split(',').map((term) => term.trim());
    enTerms.forEach((term, i) => {
      const target = jaTerms[i] ?? jaTerms[0];
      if (term && target) entries.push({ en: term, ja: target });
    });
  }
  return entries;
}

/** A glossary as DeepL's TSV entries, one per source term, the first one winning. */
export function glossaryTsv(entries: GlossaryEntry[], from: 'en' | 'ja'): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of entries) {
    const source = from === 'en' ? entry.en : entry.ja;
    const target = from === 'en' ? entry.ja : entry.en;
    if (seen.has(source)) continue;
    seen.add(source);
    lines.push(`${source}\t${target}`);
  }
  return lines.join('\n');
}

function mentions(english: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(?:s|es)?\\b`, 'i').test(english);
}

/** The glossary terms the reference translation uses for the English but our Japanese does not. */
function glossaryMisses(pair: Pair, reference: string, glossary: GlossaryEntry[]): string[] {
  return glossary
    .filter((entry) => mentions(pair.en, entry.en) && reference.includes(entry.ja) && !pair.ja.includes(entry.ja))
    .map((entry) => `${entry.en} → ${entry.ja}`);
}

/** Reviews every pair, translating all of them in each direction at once. */
export async function review(
  pairs: Pair[],
  translator: Translator,
  glossary: GlossaryEntry[] = [],
  threshold = THRESHOLD,
): Promise<Review[]> {
  if (pairs.length === 0) return [];
  const [references, backs] = await Promise.all([
    translator.translate(
      pairs.map((pair) => pair.en),
      'EN',
      'JA',
    ),
    translator.translate(
      pairs.map((pair) => pair.ja),
      'JA',
      'EN',
    ),
  ]);
  return pairs.map((pair, i) => {
    const reference = references[i] ?? '';
    const back = backs[i] ?? '';
    const referenceScore = chrf(pair.ja, reference);
    const backScore = chrf(back, pair.en);
    const problems: string[] = [];
    if (/[a-z]{3}/i.test(pair.en) && !JAPANESE.test(pair.ja)) {
      problems.push('left in English');
    } else if (referenceScore < threshold && backScore < threshold) {
      problems.push('far from the reference in both directions');
    }
    const misses = glossaryMisses(pair, reference, glossary);
    if (misses.length > 0) problems.push(`glossary: ${misses.join(', ')}`);
    return { ...pair, reference, back, referenceScore, backScore, problems };
  });
}

export interface Section {
  /** The heading that opens the section as written, or "frontmatter" for the title and description. */
  heading: string;
  /** The 1-based line the section starts on. */
  line: number;
  /** The section's readable text: prose and the human-readable attributes, no code. */
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,4})\s+(.*)$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const READABLE_FRONTMATTER = /^(title|description|sidebarTitle):\s*(.*)$/;
const READABLE_ATTRIBUTE = /\b(?:title|subtitle|description|label|alt|aria-label)="([^"]*)"/g;

/** A section's MDX reduced to what a reader reads. */
function readable(mdx: string): string {
  return mdx
    .replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s*import\s.*$/gm, ' ')
    .replace(/^\s*export const \w+ = `/gm, ' ')
    .replace(/`;\s*$/gm, ' ')
    .replaceAll('\\`', '`')
    .replace(/<\/?[A-Za-z][\w.]*(?:\s[^>]*)?\/?>/g, (tag) =>
      [...tag.matchAll(READABLE_ATTRIBUTE)].map((match) => ` ${match[1]!} `).join(''),
    )
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|\|/g, ' ')
    .replace(/(?<=^|\s):?-{3,}:?(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A page split at its headings (h1 to h4, outside code fences), with the
 * frontmatter's title and description as the first section. While a
 * translation keeps its English page's outline, the sections of the two pair
 * up by position; translations are best effort, so a caller checks the
 * counts match first.
 */
export function sections(source: string): Section[] {
  const normalized = source.replaceAll('\r\n', '\n');
  const frontmatter = FRONTMATTER.exec(normalized);
  const result: Section[] = [
    {
      heading: 'frontmatter',
      line: 1,
      text: (frontmatter?.[1] ?? '')
        .split('\n')
        .flatMap((line) => {
          const value = READABLE_FRONTMATTER.exec(line)?.[2]?.trim();
          return value ? [value.replace(/^["']|["']$/g, '')] : [];
        })
        .join(' '),
    },
  ];
  const offset = frontmatter ? frontmatter[0].split('\n').length - 1 : 0;
  const lines = normalized.slice(frontmatter?.[0].length ?? 0).split('\n');
  let body: string[] = [];
  let current: Omit<Section, 'text'> | undefined;
  let fence: string | undefined;
  const close = () => {
    if (current) result.push({ ...current, text: readable(body.join('\n')) });
    body = [];
  };
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { heading: heading[2]!.trim(), line: offset + i + 1 };
      body.push(heading[2]!);
      return;
    }
    if (!current) current = { heading: 'introduction', line: offset + i + 1 };
    body.push(line);
  });
  close();
  return result;
}

// DeepL caps a request at 128 KiB, and a Japanese character is 3 bytes in UTF-8.
const BATCH_CHARS = 30_000;
const BATCH_TEXTS = 50;

/**
 * A DeepL client: the Free API for a key ending in `:fx`, Pro otherwise. The
 * glossary is uploaded once per content and reused by name, so editing the
 * README's table uploads a new one and an unchanged one costs nothing.
 */
export function deepl(
  key: string,
  glossary: GlossaryEntry[] = [],
  fetchImpl: typeof fetch = fetch,
): Translator & { usage(): Promise<Usage> } {
  const api = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const headers = { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' };

  async function call<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`${api}${path}`, { ...init, headers });
      if (response.ok) return (await response.json()) as T;
      if (response.status === 456) throw new QuotaExceeded(`DeepL's character quota for the month is used up`);
      const retry = response.status === 429 || response.status >= 500;
      if (!retry || attempt === 4) {
        const trace = response.headers.get('x-trace-id') ?? 'none';
        throw new Error(`DeepL ${path} answered ${response.status}: ${await response.text()} (trace ${trace})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }

  let glossaryId: Promise<string | undefined> | undefined;
  function glossaryFor(): Promise<string | undefined> {
    glossaryId ??= (async () => {
      if (glossary.length === 0) return undefined;
      const dictionaries = (['en', 'ja'] as const).map((from) => ({
        source_lang: from,
        target_lang: from === 'en' ? 'ja' : 'en',
        entries: glossaryTsv(glossary, from),
        entries_format: 'tsv',
      }));
      const name = `e2e docs ja ${hash(JSON.stringify(dictionaries))}`;
      const { glossaries } = await call<{ glossaries: { glossary_id: string; name: string }[] }>('/v3/glossaries');
      const existing = glossaries.find((entry) => entry.name === name);
      if (existing) return existing.glossary_id;
      const created = await call<{ glossary_id: string }>('/v3/glossaries', {
        method: 'POST',
        body: JSON.stringify({ name, dictionaries }),
      });
      return created.glossary_id;
    })();
    return glossaryId;
  }

  return {
    name: 'DeepL',
    async usage() {
      const usage = await call<{ character_count: number; character_limit: number }>('/v2/usage');
      return { count: usage.character_count, limit: usage.character_limit };
    },
    async translate(texts, from, to) {
      const glossary_id = await glossaryFor();
      const out: string[] = [];
      for (const batch of batches(texts)) {
        const { translations } = await call<{ translations: { text: string }[] }>('/v2/translate', {
          method: 'POST',
          body: JSON.stringify({
            text: batch,
            source_lang: from,
            target_lang: to === 'EN' ? 'EN-US' : to,
            ...(to === 'JA' ? { formality: 'prefer_more' } : {}),
            ...(glossary_id ? { glossary_id } : {}),
            split_sentences: 'nonewlines',
          }),
        });
        out.push(...translations.map((translation) => translation.text));
      }
      return out;
    },
  };
}

/** The model `gateway` translates with when DeepL's quota is used up. */
const FALLBACK_MODEL = 'openai/gpt-6-luna';

const LANGUAGE = { EN: 'English', JA: 'Japanese' } as const;

// Smaller than DeepL's batches: a model keeps a short list in order more
// reliably, and a docs section can run to thousands of characters.
const GATEWAY_BATCH_TEXTS = 20;
const GATEWAY_BATCH_CHARS = 8_000;

/**
 * A translator on the Vercel AI Gateway, for when DeepL's quota is used up.
 * The model gets the glossary and the docs' style (polite です・ます form,
 * product names kept in English) and answers a JSON list of translations, one
 * per text, in order.
 */
export function gateway(
  key: string,
  glossary: GlossaryEntry[] = [],
  fetchImpl: typeof fetch = fetch,
  model = FALLBACK_MODEL,
): Translator {
  const terms = glossary.map((entry) => `${entry.en} = ${entry.ja}`).join('\n');

  async function translateBatch(texts: string[], from: 'EN' | 'JA', to: 'EN' | 'JA'): Promise<string[]> {
    const system = [
      `Translate each ${LANGUAGE[from]} text of a developer tool's documentation into ${LANGUAGE[to]}.`,
      'Translate each text on its own, faithfully: no additions, no omissions, no explanations.',
      to === 'JA'
        ? 'Use the polite です・ます form and keep product, package, and API names in English.'
        : 'Keep product, package, and API names as they are.',
      terms ? `Use these terms (English = Japanese):\n${terms}` : '',
      'Answer JSON: {"translations": [...]}, one string per input text, in the same order.',
    ]
      .filter(Boolean)
      .join('\n\n');
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl('https://ai-gateway.vercel.sh/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify({ texts }) },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'translations',
              strict: true,
              schema: {
                type: 'object',
                properties: { translations: { type: 'array', items: { type: 'string' } } },
                required: ['translations'],
                additionalProperties: false,
              },
            },
          },
        }),
      });
      const retry = response.status === 429 || response.status >= 500;
      if (!response.ok && (!retry || attempt === 4)) {
        throw new Error(`AI Gateway ${model} answered ${response.status}: ${await response.text()}`);
      }
      if (response.ok) {
        const body = (await response.json()) as { choices: { message: { content: string } }[] };
        const translations = parseTranslations(body.choices[0]?.message.content);
        if (
          Array.isArray(translations) &&
          translations.length === texts.length &&
          translations.every((text) => typeof text === 'string')
        ) {
          return translations as string[];
        }
        if (attempt === 4) throw new Error(`AI Gateway ${model} did not answer one translation per text`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    }
  }

  return {
    name: model,
    async translate(texts, from, to) {
      const out: string[] = [];
      for (const batch of batches(texts, GATEWAY_BATCH_TEXTS, GATEWAY_BATCH_CHARS)) {
        out.push(...(await translateBatch(batch, from, to)));
      }
      return out;
    },
  };
}

/** The model's `translations` list, or undefined for an answer that is not the JSON asked for. */
function parseTranslations(content: string | undefined): unknown {
  try {
    const parsed: unknown = JSON.parse(content ?? '');
    return typeof parsed === 'object' && parsed !== null && 'translations' in parsed ? parsed.translations : undefined;
  } catch {
    return undefined;
  }
}

/**
 * DeepL until its monthly quota is used up, then `fallback` for the rest of
 * the run. `name` says who translated last, for the report.
 */
export function withFallback(primary: Translator, fallback: Translator | undefined): Translator {
  let current = primary;
  return {
    get name() {
      return current.name;
    },
    async translate(texts, from, to) {
      try {
        return await current.translate(texts, from, to);
      } catch (error) {
        if (!(error instanceof QuotaExceeded) || !fallback) throw error;
        current = fallback;
        return fallback.translate(texts, from, to);
      }
    },
  };
}

function* batches(texts: string[], maxTexts = BATCH_TEXTS, maxChars = BATCH_CHARS): Generator<string[]> {
  let batch: string[] = [];
  let size = 0;
  for (const text of texts) {
    if (batch.length > 0 && (batch.length === maxTexts || size + text.length > maxChars)) {
      yield batch;
      batch = [];
      size = 0;
    }
    batch.push(text);
    size += text.length;
  }
  if (batch.length > 0) yield batch;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}
