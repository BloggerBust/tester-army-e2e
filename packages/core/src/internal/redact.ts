/** Runner-side secret redaction. */

import { StringDecoder } from 'node:string_decoder';
import { MIN_SECRET_LENGTH, secretLength } from '../config/secrets.ts';
import { escapeRegexpChar } from './regexp.ts';

/**
 * Builds a redactor replacing every registered secret value, in each spelling
 * the value takes in text the runner writes or rewrites, with its stable
 * secret name.
 *
 * Occurrences are rewritten leftmost first, and where two values start at
 * one position the longer wins, so a secret that contains another secret is
 * rewritten whole, not half. A marker is never read again once written: the
 * text is cut at the markers of the names the redactor knows and those
 * pieces are left as they are, so redacting twice is redacting once and a
 * value that occurs inside a marker (`api` inside `<secret:apiKey>`, the word
 * `secret` itself) cannot rewrite it. Only known names are cut out: a
 * marker-shaped span of app text holding a raw value is not a marker and is
 * still redacted.
 */
export function createRedactor(
  secrets: Iterable<readonly [string, string]>,
): (text: string) => string {
  return compile([...secrets]).redact;
}

interface Compiled {
  readonly redact: (text: string) => string;
  /** `redact` for text cut short at a length limit; see `SecretLedger.redactCut`. */
  readonly redactCut: (text: string) => string;
  readonly safeRedactionBoundary: (text: string, offset: number) => number;
  /** `redact` that also rewrites fragments of values; see `SecretLedger.redactFragments`. */
  readonly redactFragments: (text: string) => string;
  /** Every occurrence of every value, leftmost first and never overlapping: the matches `redact` rewrites. Absent with no values. */
  readonly pattern: RegExp | undefined;
  /** The most text one occurrence can span; a piece shorter than this holds at most part of one. */
  readonly maxFormLength: number;
  /** The longest marker of a known name; a marker cut short at that length or beyond cannot complete into one. */
  readonly maxMarkerLength: number;
  /** Whether a value can match across a line break, holding one or inner whitespace one stands for: the one case an unfinished line cannot be cut from the line before it. */
  readonly spansLines: boolean;
}

const MARKER_OPEN = '<secret:';
/**
 * The fewest consecutive characters of a value that count as a fragment of
 * it. Fewer say next to nothing about a long value, and a shorter run
 * matches ordinary text often enough to mangle it and, by being masked,
 * tell the reader the value's characters.
 */
const FRAGMENT_LENGTH = 8;
/** What a secret name spells inside its marker; a `>` closes it. */
const MARKER_NAME = /^[A-Za-z0-9_.-]*$/;

/**
 * One pattern over every non-empty value, longest value first. A value
 * matches character by character, each in any case and in any spelling a
 * serializer gives it, so one pattern covers a JSON body, a serialized page, a
 * URL, the raw value, and the value as a text reader or a CSS `text-transform`
 * shows it alike, and a mixed or unusual spelling needs no form of its own.
 * The `i` flag matches hex digits in either case and folds what the
 * per-character case forms leave out: a sigma lower-cased at the end of a
 * word, a titlecase digraph.
 */
function compile(values: readonly (readonly [string, string])[], wholeOnly: ReadonlySet<readonly [string, string]> = new Set()): Compiled {
  const entries = values.filter(([, value]) => value.length > 0).toSorted((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) {
    return {
      redact: (text) => text,
      redactCut: (text) => text,
      safeRedactionBoundary: (_text, offset) => offset,
      redactFragments: (text) => text,
      pattern: undefined,
      maxFormLength: 0,
      maxMarkerLength: 0,
      spansLines: false,
    };
  }
  const markers = entries.map(([name]) => `${MARKER_OPEN}${name}>`);
  const known = markerPattern(entries.map(([name]) => name));
  const patterns = entries.map(([, value]) => valuePattern(value));
  const pattern = valuesPattern(patterns.map(({ source }) => `(${source})`).join('|'));
  const rewrite = (text: string): string =>
    text.replace(pattern, (_occurrence: string, ...groups: unknown[]) => {
      for (let index = 0; index < markers.length; index += 1) {
        if (groups[index] !== undefined) return markers[index] ?? '';
      }
      return '';
    });
  // Every marker starts with `MARKER_OPEN`, so text without it has none to cut out. Otherwise
  // `split` on a capturing pattern returns the markers at the odd indexes; those pass through untouched.
  const redact = (text: string): string =>
    text.includes(MARKER_OPEN)
      ? text.split(known).map((piece, index) => (index % 2 === 1 ? piece : rewrite(piece))).join('')
      : rewrite(text);

  // Move the boundary to the end of any secret match or marker it intersects.
  const safeRedactionBoundary = (text: string, offset: number): number => {
    let start = 0;
    const pieces = text.includes(MARKER_OPEN) ? text.split(known) : [text];
    for (const [index, piece] of pieces.entries()) {
      const end = start + piece.length;
      if (start < offset && offset < end) {
        if (index % 2 === 1) return end;
        pattern.lastIndex = 0;
        for (let match = pattern.exec(piece); match !== null && start + match.index < offset; match = pattern.exec(piece)) {
          const after = start + match.index + match[0].length;
          if (after > offset) return after;
        }
        break;
      }
      start = end;
    }
    return offset;
  };
  const valueKeys = entries.map(([, value]) => readingKey(value).key);
  // A reader trims a value's leading whitespace as it trims any text's, so a cut part may begin past it.
  const leadingForms = entries.map(([, value], index) => {
    const key = valueKeys[index] ?? '';
    return secretLength(value.trim()) >= MIN_SECRET_LENGTH && key.trimStart() !== key ? [key, key.trimStart()] : [key];
  });
  const redactCut = (text: string): string => {
    // Only what follows the last marker can end in a value cut short.
    const tail = text.includes(MARKER_OPEN) ? (text.split(known).at(-1) ?? '') : text;
    const tailKey = readingKey(tail);
    let cut = 0;
    let marker = '';
    leadingForms.forEach((forms, index) => {
      for (const value of forms) {
        const length = leadingPartAtEnd(tailKey.key, value, cutMinimum(value, wholeOnly.has(entries[index]!)));
        if (length > cut) {
          cut = length;
          marker = markers[index] ?? '';
        }
      }
    });
    if (cut === 0) return redact(text);
    // An occurrence the whole-value pass would rewrite across the fragment's start joins the fragment.
    let start = tailKey.at(tailKey.key.length - cut);
    pattern.lastIndex = 0;
    for (let match = pattern.exec(tail); match !== null && match.index < start; match = pattern.exec(tail)) {
      if (match.index + match[0].length > start) {
        start = match.index;
        break;
      }
    }
    return `${redact(text.slice(0, text.length - tail.length + start))}${marker}`;
  };
  // A provider key shares its prefix with every key of its kind (`sk-proj-`), so only the whole of one is a match.
  const fragments = fragmentOwners(valueKeys, (index) => wholeOnly.has(entries[index]!));
  const redactPlainFragments = (text: string): string =>
    redact(text)
      .split(known)
      .map((piece, index) => (index % 2 === 1 ? piece : rewriteFragments(piece, fragments, markers)))
      .join('');
  const redactFragments = (text: string): string => rewriteEncoded(redactPlainFragments(text), redactPlainFragments, known);
  return {
    redact,
    redactCut,
    safeRedactionBoundary,
    redactFragments,
    pattern,
    maxFormLength: Math.max(...patterns.map(({ maxLength }) => maxLength)),
    maxMarkerLength: Math.max(...markers.map((marker) => marker.length)),
    spansLines: entries.some(([, value]) => value.includes('\n') || /\s/.test(value.trim())),
  };
}

/**
 * The pattern over every value. A value long enough makes the engine refuse
 * the pattern, and its error quotes the pattern, values and all: that error
 * never leaves here.
 */
function valuesPattern(source: string): RegExp {
  try {
    const pattern = new RegExp(source, 'gi');
    // The engine compiles a pattern when it first runs it, once for Latin-1 text and once for the rest, and refuses one too large only then.
    pattern.test('');
    pattern.test('\u0100');
    pattern.lastIndex = 0;
    return pattern;
  } catch {
    throw new Error('the secret values are too long to redact: shorten the longest secret, or take it out of the run');
  }
}

/** Matches the marker of any known name, captured so `split` keeps the markers. */
function markerPattern(names: readonly string[]): RegExp {
  const alternatives = [...new Set(names)].map(literal).join('|');
  return new RegExp(`(<secret:(?:${alternatives})>)`);
}

interface Pattern {
  readonly source: string;
  /** The most text one match can span. */
  readonly maxLength: number;
}

/**
 * The source matching `value` in every spelling, and the most text one match
 * of it can span. Each character matches in every case form and spelling
 * (`character`). A whitespace run between two other characters matches as a
 * text reader may leave it (`whitespaceRun`); one at either end matches as
 * written or not at all, as the reader trims it, unless trimming leaves the
 * value shorter than a secret may be.
 */
function valuePattern(value: string): Pattern {
  const trimmable = secretLength(value.trim()) >= MIN_SECRET_LENGTH;
  // `split` on a capturing pattern returns the whitespace runs at the odd indexes.
  const pieces = value.split(/(\s+)/);
  return concat(
    pieces.map((piece, index) => {
      const run = index % 2 === 1;
      if (run && pieces[index - 1] !== '' && pieces[index + 1] !== '') return whitespaceRun(piece);
      const written = concat([...piece].map(character));
      return run && trimmable ? { source: `(?:${written.source})?`, maxLength: written.maxLength } : written;
    }),
  );
}

/**
 * A whitespace run inside a value: one to as many whitespace characters as it
 * has, each any whitespace character or the spelling of a space or of one of
 * the run's own characters, so the run as written and the one space a reader
 * collapses it to (`normalizeText`) both match.
 */
function whitespaceRun(run: string): Pattern {
  const spelled = [...new Set([' ', ...run])].flatMap(spellings).filter((spelling) => !/^\s$/.test(spelling));
  const one = alternation([{ source: '\\s', maxLength: 1 }, ...distinct(spelled).map(exact)]);
  const count = [...run].length;
  return { source: `${one.source}{1,${count}}`, maxLength: one.maxLength * count };
}

/** The most characters `characterPatterns` keeps; one past that is built on every use. */
const CHARACTER_CACHE_LIMIT = 4096;
/**
 * Each character's pattern, kept for the process. A pattern depends on its
 * character alone, never on a ledger, a name, or a value, so every compile
 * shares them: building one calls six locale case mappings, and a ledger
 * compiles again at each registration.
 */
const characterPatterns = new Map<string, Pattern>();

/**
 * One character in every case form and every spelling of each. A spelling
 * the `i` flag already matches through another (`a` beside `A`, `é` beside
 * `É`) is left out, so no two alternatives match the same text: a near miss
 * then costs the pattern one try per alternative, not one per combination of
 * them across the value.
 */
function character(ch: string): Pattern {
  const kept = characterPatterns.get(ch);
  if (kept !== undefined) return kept;
  const forms = caseForms(ch);
  const single = forms.filter((form) => [...form].length === 1).flatMap(spellings);
  const expanded = forms
    .filter((form) => [...form].length > 1)
    .map((form) => concat([...form].map((part) => alternation(distinct(spellings(part)).map(exact)))));
  const pattern = alternation([...distinct(single).map(exact), ...expanded]);
  if (characterPatterns.size < CHARACTER_CACHE_LIMIT) characterPatterns.set(ch, pattern);
  return pattern;
}

/** `options` as one alternation, longest first, so a spelling is never cut short by one it starts with. */
function alternation(options: readonly Pattern[]): Pattern {
  if (options.length === 1) return options[0]!;
  const sorted = options.toSorted((a, b) => b.maxLength - a.maxLength);
  return {
    source: `(?:${sorted.map(({ source }) => source).join('|')})`,
    maxLength: sorted[0]?.maxLength ?? 0,
  };
}

/** `parts` one after another. */
function concat(parts: readonly Pattern[]): Pattern {
  return {
    source: parts.map(({ source }) => source).join(''),
    maxLength: parts.reduce((sum, { maxLength }) => sum + maxLength, 0),
  };
}

/** `text` matched literally. */
function exact(text: string): Pattern {
  return { source: literal(text), maxLength: text.length };
}

/** `texts` without the ones an earlier one matches under the `i` flag. */
function distinct(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((spelling) => {
    const key = folded(spelling);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `text` as the `i` flag compares it outside Unicode mode (ECMA-262
 * Canonicalize): each UTF-16 unit upper-cased, unless that takes more than
 * one unit or maps a non-ASCII unit into ASCII. Two literals match the same
 * text exactly when these agree.
 */
function folded(text: string): string {
  return text
    .split('')
    .map((unit) => {
      const upper = unit.toUpperCase();
      return upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
    })
    .join('');
}

/**
 * `text` with every character in one case, for comparing a cut or a fragment
 * of a value as whole-value matching does: each code point lower-cased from
 * its upper case, the Turkish lower case standing in where the default one
 * takes more units (`İ` as `i`), so `ſ`, `S`, and `s` agree, and so do `İ`
 * and `i`. A mapping that changes the length (`ß` as `SS`) is left out, so
 * an index into the result is one into `text`.
 */
function caseKey(text: string): string {
  if (!/[^\p{ASCII}]/u.test(text)) return text.toLowerCase();
  let out = '';
  for (const ch of text) out += ch.charCodeAt(0) < 128 ? ch.toLowerCase() : caseKeyOf(ch);
  return out;
}

/** A text as a cut or a fragment of a value is compared, and where each of its units starts in the text. */
interface ReadingKey {
  readonly key: string;
  /** The index in the text of the unit of `key` at `index`; `key.length` maps to the text's length, so a stretch of `key` maps back to one of the text. */
  readonly at: (index: number) => number;
}

/** Whitespace a reader rewrites: a run of two or more, or one character other than a plain space. */
const COLLAPSIBLE = /\s\s|[^\S ]/u;
/** UTF-16 units joined into one string at a time when the key is rebuilt. */
const KEY_CHUNK = 8192;

/**
 * `text` as a cut or a fragment of a value is compared: `caseKey`, with each
 * whitespace run read as one space, as an engine that collapses whitespace
 * (`normalizeText`) shows it before cutting. A value holding a line break, a
 * tab, a CRLF, a no-break space, or a run of spaces then agrees with what a
 * collapsed text keeps of it, and a stretch of the key maps back to the text
 * through `at`. `caseKey` keeps every index, so text with nothing to collapse
 * is its own key. Otherwise the key is rebuilt unit by unit into a typed
 * array, and `at` keeps one pair of offsets per collapsed run: a trace text
 * of many megabytes costs a few times its size, never an object per unit.
 */
function readingKey(text: string): ReadingKey {
  const cased = caseKey(text);
  if (!COLLAPSIBLE.test(cased)) return { key: cased, at: (index) => index };
  const units = new Uint16Array(cased.length);
  // Pairs of where a stretch after a collapsed run starts, in the key and in the text.
  let breaks = new Int32Array(64);
  let pairs = 0;
  let length = 0;
  for (let index = 0; index < cased.length; index += 1) {
    const unit = cased.charCodeAt(index);
    if (!isWhitespace(unit)) {
      units[length++] = unit;
      continue;
    }
    let end = index + 1;
    while (end < cased.length && isWhitespace(cased.charCodeAt(end))) end += 1;
    units[length++] = 0x20;
    if (end - index > 1 || unit !== 0x20) {
      if (2 * pairs + 2 > breaks.length) {
        const grown = new Int32Array(breaks.length * 2);
        grown.set(breaks);
        breaks = grown;
      }
      breaks[2 * pairs] = length;
      breaks[2 * pairs + 1] = end;
      pairs += 1;
    }
    index = end - 1;
  }
  const chunks: string[] = [];
  for (let start = 0; start < length; start += KEY_CHUNK) {
    chunks.push(String.fromCharCode(...units.subarray(start, Math.min(length, start + KEY_CHUNK))));
  }
  return {
    key: chunks.join(''),
    at: (index) => {
      // The last stretch starting at or before `index`; before the first run the key and the text agree.
      let low = -1;
      let high = pairs - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if ((breaks[2 * middle] ?? 0) <= index) low = middle;
        else high = middle - 1;
      }
      return low === -1 ? index : (breaks[2 * low + 1] ?? 0) + index - (breaks[2 * low] ?? 0);
    },
  };
}

/** Whether a UTF-16 unit is one `\s` matches: what `normalizeText` collapses. */
function isWhitespace(unit: number): boolean {
  return (
    unit === 0x20 ||
    (unit >= 0x09 && unit <= 0x0d) ||
    unit === 0xa0 ||
    unit === 0x1680 ||
    (unit >= 0x2000 && unit <= 0x200a) ||
    unit === 0x2028 ||
    unit === 0x2029 ||
    unit === 0x202f ||
    unit === 0x205f ||
    unit === 0x3000 ||
    unit === 0xfeff
  );
}

/** One non-ASCII character's `caseKey`, the same length as `ch`. */
function caseKeyOf(ch: string): string {
  const upper = sameLength(ch.toUpperCase(), ch);
  const lower = upper.toLowerCase();
  if (lower.length === ch.length) return lower;
  return sameLength(upper.toLocaleLowerCase('tr'), upper);
}

/** `mapped` when it is as long as `original`, else `original`. */
function sameLength(mapped: string, original: string): string {
  return mapped.length === original.length ? mapped : original;
}

/** Locales whose case mappings differ from the default: the dotted and dotless i of Turkish and Azeri, Lithuanian's retained dot. */
const CASE_LOCALES = ['tr', 'az', 'lt'];

/**
 * The strings one character can become when text is upper- or lower-cased:
 * the character itself, the full mappings, so `ß` is also `SS`, and the
 * locale-specific ones a `lang` attribute selects, so `i` is also `İ`. Each
 * form is spelled on its own, so a case variant's character reference or
 * escape is covered too.
 */
function caseForms(ch: string): string[] {
  return [
    ...new Set([
      ch,
      ch.toUpperCase(),
      ch.toLowerCase(),
      ...CASE_LOCALES.flatMap((locale) => [ch.toLocaleUpperCase(locale), ch.toLocaleLowerCase(locale)]),
    ]),
  ];
}

const NAMED_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  '&': ['&amp;'],
  '<': ['&lt;'],
  '>': ['&gt;'],
  '"': ['&quot;'],
  "'": ['&apos;'],
};

/**
 * The spellings one character has in captured text: as is; as JSON writes
 * it, escaped the short way (`\"`), as `\uXXXX`, and `\/` for a slash, each
 * of those once more inside a quoted JSON string (a JSON request body inside
 * a HAR field); as an HTML character reference, named, decimal, zero-padded
 * decimal, or hex; and percent-encoded, with `+` for a space; and a double
 * quote doubled, as CSV writes it inside a quoted field. Hex digits are
 * spelled in lower case; the pattern's `i` flag matches them in upper too. A
 * letter or digit has one spelling: no serializer rewrites those.
 */
function spellings(ch: string): string[] {
  if (/^[A-Za-z0-9]$/.test(ch)) return [ch];
  const inJson = [JSON.stringify(ch).slice(1, -1), unicodeEscape(ch), ...(ch === '/' ? ['\\/'] : [])];
  const codePoint = ch.codePointAt(0) ?? 0;
  const decimal = String(codePoint);
  return [
    ...new Set([
      ch,
      ...inJson,
      ...inJson.map((form) => JSON.stringify(form).slice(1, -1)),
      ...(NAMED_REFERENCES[ch] ?? []),
      `&#${decimal};`,
      `&#${decimal.padStart(3, '0')};`,
      `&#x${codePoint.toString(16)};`,
      [...Buffer.from(ch, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''),
      ...(ch === ' ' ? ['+'] : []),
      ...(ch === '"' ? ['""'] : []),
    ]),
  ];
}

/** `\uXXXX` per UTF-16 code unit. */
function unicodeEscape(ch: string): string {
  const units = Array.from({ length: ch.length }, (_, index) => ch.charCodeAt(index));
  return units.map((unit) => `\\u${unit.toString(16).padStart(4, '0')}`).join('');
}

/**
 * The fewest leading characters of `value` that count as it cut short. A
 * secret of the run: `FRAGMENT_LENGTH`, or half of a shorter one. A provider
 * key: half of it, and at least twice `FRAGMENT_LENGTH`, since every key of a
 * provider starts alike (`sk-proj-`, a token's header) and text that merely
 * ends with that start is no key.
 */
function cutMinimum(value: string, wholeOnly: boolean): number {
  const half = Math.ceil(value.length / 2);
  return wholeOnly ? Math.max(FRAGMENT_LENGTH * 2, half) : Math.min(FRAGMENT_LENGTH, half);
}

/** The length of the longest leading part of `value`, short of the whole and at least `minimum` long, that `text` ends with; 0 when it ends with none. */
function leadingPartAtEnd(text: string, value: string, minimum: number): number {
  for (let length = Math.min(text.length, value.length - 1); length >= minimum; length -= 1) {
    if (text.endsWith(value.slice(0, length))) return length;
  }
  return 0;
}

/**
 * Every run of `FRAGMENT_LENGTH` characters of every value, mapped to the
 * index of the first value holding it; values come longest first, so a run
 * two values share names the longer one. The values come as `readingKey`
 * reads them, so a run in any case or with its whitespace collapsed finds
 * its owner. A value `wholeOnly` names owns no run: only the whole of it is
 * a match.
 */
function fragmentOwners(values: readonly string[], wholeOnly: (index: number) => boolean): Map<string, number> {
  const owners = new Map<string, number>();
  values.forEach((value, index) => {
    if (wholeOnly(index)) return;
    for (let start = 0; start + FRAGMENT_LENGTH <= value.length; start += 1) {
      const run = value.slice(start, start + FRAGMENT_LENGTH);
      if (!owners.has(run)) owners.set(run, index);
    }
  });
  return owners;
}

/**
 * `text` with every stretch whose windows of `FRAGMENT_LENGTH` characters
 * each occur in a value replaced by the marker of the value owning its first
 * window. Windows are looked up by `readingKey`, as `owners` is keyed, so a
 * fragment in another case or with another whitespace run is one too, and
 * the stretch is cut back out of `text` whole, its inner whitespace runs
 * included. A whitespace run at either end stays outside the marker, so
 * where a diff's `+` or `-` prefix splits a multi-line value, the line break
 * and the prefix keep their places; a context line that continues the value
 * folds into the same marker. The scan resumes on the whitespace it kept, so
 * a fragment starting there is rewritten too. The stretch grows one window at
 * a time, so the scan is linear in the text and a run spanning two values
 * becomes one marker.
 */
function rewriteFragments(text: string, owners: ReadonlyMap<string, number>, markers: readonly string[]): string {
  if (owners.size === 0) return text;
  const { key, at } = readingKey(text);
  let out = '';
  let kept = 0;
  let start = 0;
  while (start + FRAGMENT_LENGTH <= key.length) {
    const owner = owners.get(key.slice(start, start + FRAGMENT_LENGTH));
    if (owner === undefined) {
      start += 1;
      continue;
    }
    let end = start + FRAGMENT_LENGTH;
    while (end < key.length && owners.has(key.slice(end + 1 - FRAGMENT_LENGTH, end + 1))) end += 1;
    const from = key.charCodeAt(start) === 0x20 ? start + 1 : start;
    const to = key.charCodeAt(end - 1) === 0x20 ? end - 1 : end;
    out += `${text.slice(kept, at(from))}${markers[owner] ?? ''}`;
    kept = at(to);
    start = to;
  }
  return out + text.slice(kept);
}

/**
 * A run of base64 or base64url text long enough to encode a fragment: a
 * basic-auth header, a cookie, a token segment. Padding is part of the run.
 */
const ENCODED_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;

/**
 * `text` with every base64 run whose decoded text holds a value, whole or a
 * fragment, replaced by that value's marker. An encoder spreads a value's
 * bytes over the characters around it, so no plain-text spelling of the value
 * matches the run: the run is decoded and read the way `redactDecoded` reads
 * text, and it is rewritten whole, so no character of the value survives.
 */
function rewriteEncoded(text: string, redactDecoded: (text: string) => string, known: RegExp): string {
  return text
    .split(known)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(ENCODED_RUN, (run) => encodedMarker(run, redactDecoded, known) ?? run),
    )
    .join('');
}

/**
 * The marker of the first value `run` decodes to text holding. The run can
 * start with text the encoding does not (a URL path, a cookie prefix), so it
 * is decoded from each of the four offsets a base64 group can start at. A
 * marker the decoded text already holds is page text, not a value, so only
 * the text between such markers is read.
 */
function encodedMarker(run: string, redactDecoded: (text: string) => string, known: RegExp): string | undefined {
  const base64 = run.replaceAll('-', '+').replaceAll('_', '/');
  for (const offset of [0, 1, 2, 3]) {
    const pieces = Buffer.from(base64.slice(offset), 'base64').toString('utf8').split(known);
    for (const piece of pieces.filter((_, index) => index % 2 === 0)) {
      const marker = known.exec(redactDecoded(piece))?.[1];
      if (marker !== undefined) return marker;
    }
  }
  return undefined;
}

function literal(text: string): string {
  return [...text].map(escapeRegexpChar).join('');
}

/**
 * `cut`, moved back to the `<` of a marker the text before it cuts short:
 * `<`, `<s`, ... `<secret:` and name characters with no `>` yet. A stretch
 * as long as the longest known marker or longer cannot complete into one and
 * is left where it is, so the move stays under `maxMarkerLength`.
 */
function unfinishedMarkerBefore(text: string, cut: number, maxMarkerLength: number): number {
  const open = text.lastIndexOf('<', cut - 1);
  if (open === -1 || cut - open >= maxMarkerLength) return cut;
  const head = text.slice(open + 1, Math.min(cut, open + MARKER_OPEN.length));
  if (!MARKER_OPEN.startsWith(`<${head}`)) return cut;
  return MARKER_NAME.test(text.slice(open + MARKER_OPEN.length, cut)) ? open : cut;
}

/** An append-only list of secret names and values. */
export type SecretList = readonly (readonly [string, string])[];

/** Values a ledger redacts without holding them; see `SecretLedger`. */
export interface SecretsBeside {
  /** Moves whenever `values` or `providerKeys` would return a different set. */
  readonly revision: number;
  values(): SecretList;
  /**
   * The keys the run's model providers and agents sign in with. These
   * match whole values only, including when the runner scans a download.
   */
  providerKeys(): SecretList;
}

/** For a ledger that stands alone. */
const NOTHING_BESIDE: SecretsBeside = { revision: 0, values: () => [], providerKeys: () => [] };

/**
 * The attempt's registered secret values and their redactor, in one owner.
 *
 * Static credential passwords are known up front; a provider-backed value
 * exists only once the resolver produces it at fill time. Registration
 * invalidates the memoized redactor, so every consumer holding `redact` sees
 * a value the moment it exists — liveness is structural, not a comment on a
 * shared map.
 */
export class SecretLedger {
  /**
   * Every value ever registered, not just the newest per name: a rotating
   * secret (a fresh TOTP per fill) leaves its earlier codes on screen and in
   * captures, and an earlier value that stopped redacting would leak there.
   */
  private readonly values: [string, string][] = [];
  private compiled: Compiled | undefined;
  /** The revision `beside` had when `compiled` was built. */
  private besideRevision = -1;

  /**
   * `beside` names values the ledger redacts and does not hold: what other
   * owners in the process share (`run/secrecy.ts`). They are read again
   * whenever its revision moves, so a value is redacted from the moment it is
   * shared and no longer once its owner is gone. `entries` stays the
   * ledger's own.
   */
  constructor(
    initial: Iterable<readonly [string, string]> = [],
    private readonly beside: SecretsBeside = NOTHING_BESIDE,
  ) {
    for (const [name, value] of initial) this.register(name, value);
  }

  /** Registers one resolved value, and says whether it was new; earlier values for the name keep redacting. */
  register(name: string, value: string): boolean {
    if (this.values.some(([n, v]) => n === name && v === value)) return false;
    this.values.push([name, value]);
    this.compiled = undefined;
    return true;
  }

  /** Whether this ledger or a session beside it holds an app secret value. */
  get hasAppSecrets(): boolean {
    return this.values.some(([, value]) => value.length > 0) ||
      this.beside.values().some(([, value]) => value.length > 0);
  }

  /** Whether the ledger redacts anything at all: its own values, the ones beside it, or a provider key. */
  get redactsAnything(): boolean {
    return this.compile().pattern !== undefined;
  }

  /** Bound so it can be handed out as a plain function. */
  readonly redact = (text: string): string => this.compile().redact(text);

  /** Every registered name and value, in registration order. */
  entries(): readonly (readonly [string, string])[] {
    return this.values.map(([name, value]) => [name, value] as const);
  }

  /**
   * `redact` for text cut short at a length limit, as an engine cuts an
   * observed name or text: a value the cut stopped partway through leaves
   * its leading part at the end, which no whole-value match sees, so the
   * longest such part becomes that value's marker too, down to
   * `FRAGMENT_LENGTH` characters, or half of a value shorter than twice that.
   * A cut is one position, so a boundary this short seldom matches plain text
   * by chance. Matched as the value is written, in any case (`caseKey`), as
   * a CSS `text-transform` shows it, and with every whitespace run on both
   * sides read as one space (`readingKey`) and the value's leading whitespace
   * dropped where whole-value matching trims it (`valuePattern`), as an
   * engine that collapses text before cutting it shows it: the cut falls on
   * text as the engine read it, before any serializer spells it. A case
   * mapping that changes length (`ß` to `SS`) is not followed. The part is found before whole values are
   * rewritten, so a value that starts with another registered value is not
   * half rewritten as the shorter one, and an occurrence running into the
   * part joins its marker. Bound like `redact`.
   */
  readonly redactCut = (text: string): string => this.compile().redactCut(text);

  /**
   * `redact` that also rewrites every fragment of a value: a run of at least
   * `FRAGMENT_LENGTH` consecutive characters of one, anywhere in the text,
   * becomes its marker. For text where a value shows only in part, which
   * whole-value matching misses: a text download the runner keeps as the app
   * wrote it, or what a test filter sends to a model, such as a diff whose
   * line prefixes split a multi-line value.
   * Matched in any case and with whitespace runs collapsed, like `redactCut`. A
   * base64 or base64url run that decodes to text holding a value or a
   * fragment is rewritten whole (a basic-auth header the engine sent). Bound
   * like `redact`.
   */
  readonly redactFragments = (text: string): string => this.compile().redactFragments(text);

  /** The most text one registered value can match in any spelling; a piece shorter than this holds at most part of one occurrence. */
  get maxFormLength(): number {
    return this.compile().maxFormLength;
  }

  /**
   * Where `text` must be held back while more may follow: the index from
   * which a later piece could complete an occurrence or a marker. That is the
   * last `maxFormLength - 1` characters, or only the unfinished last line when
   * no value spans lines; moved back over a marker cut short at that point
   * (`<`, `<s`, ... `<secret:` and name characters with no `>` yet) when
   * one shorter than the longest known marker could still complete into it,
   * so a marker split across pieces is never rewritten inside; then moved
   * back to the start of the one occurrence the redactor would rewrite across
   * that point, so each side redacts on its own to what the whole does. The
   * marker move comes first: the other way round it could land inside an
   * occurrence holding a `<`. Occurrences never overlap, so each move is
   * one and what is held stays under twice `maxFormLength` plus a marker.
   * No occurrence holds a line break unless a value spans lines, so none
   * runs across a cut that follows one, and the search for one starts at the
   * cut's own line: a stream of finished lines is searched once, by `redact`.
   */
  holdFrom(text: string): number {
    const { pattern, spansLines, maxFormLength, maxMarkerLength } = this.compile();
    if (pattern === undefined) return text.length;
    const lineStart = spansLines ? 0 : text.lastIndexOf('\n') + 1;
    let cut = Math.max(lineStart, text.length - (maxFormLength - 1));
    // An unfinished marker holds no line break, so the cut stays on the line that starts at `lineStart`.
    cut = unfinishedMarkerBefore(text, cut, maxMarkerLength);
    if (cut === 0 || cut === text.length) return cut;
    if (!spansLines && text.charCodeAt(cut - 1) === 0x0a) return cut;
    pattern.lastIndex = lineStart;
    for (let match = pattern.exec(text); match !== null && match.index < cut; match = pattern.exec(text)) {
      if (match.index + match[0].length > cut) return match.index;
    }
    return cut;
  }

  safeRedactionBoundary(text: string, offset: number): number {
    return this.compile().safeRedactionBoundary(text, offset);
  }

  private compile(): Compiled {
    this.sync();
    // A provider key that is also a secret of the run comes after it here, so the run's name and its fragments win.
    const keys = this.beside.providerKeys();
    this.compiled ??= compile([...this.appValues(), ...keys], new Set(keys));
    return this.compiled;
  }

  /** Drops what was compiled once `beside` has moved. */
  private sync(): void {
    const { revision } = this.beside;
    if (revision === this.besideRevision) return;
    this.besideRevision = revision;
    this.compiled = undefined;
  }

  /** The ledger's values and the ones shared beside it. A value it holds is usually shared too; one alternative each is enough. */
  private appValues(): SecretList {
    const all = new Map<string, readonly [string, string]>();
    for (const entry of [...this.values, ...this.beside.values()]) all.set(`${entry[0]}\0${entry[1]}`, entry);
    return [...all.values()];
  }
}

/**
 * Tracks a boundary between successive writes.
 * Create it with `{ outputPrefixLength: 0 }` and pass it to subsequent
 * `push` and `flush` calls until the output reaches the boundary.
 */
export interface StreamBoundary {
  outputPrefixLength: number;
  pendingInputLength?: number;
}

/**
 * Redaction for text that arrives in pieces, as a stream writes it, so a
 * value split across two writes is still caught. Each `push` returns what is
 * safe to pass on and holds back the rest: the tail a later piece could
 * complete into a value or a `<secret:name>` marker, as the ledger measures
 * it. Bytes are decoded as UTF-8 with a character split across byte pieces
 * kept whole; a string piece ends an unfinished character first, as a
 * terminal shows the bytes Node wrote before it. `flush` releases what is
 * held, redacted, when the stream ends. The pieces together redact to
 * exactly what the whole text would.
 */
export class StreamRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private held = '';

  constructor(private readonly ledger: SecretLedger) {}

  /**
   * Returns the redacted text that is safe to release and updates the boundary
   * if provided.
   */
  push(chunk: string | Uint8Array, boundary?: StreamBoundary): string {
    if (boundary) boundary.outputPrefixLength = 0;
    if (chunk.length === 0) return '';

    const firstWriteAfterBoundary =
      boundary !== undefined && boundary.pendingInputLength === undefined;
    const endsPendingSequence =
      typeof chunk === 'string' ||
        (firstWriteAfterBoundary && (chunk[0]! & 0xc0) !== 0x80);
    const decoderTail = endsPendingSequence ? this.decoder.end() : '';

    if (boundary) boundary.pendingInputLength ??= this.held.length + decoderTail.length;

    const text =
      this.held + decoderTail +
        (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const cut = this.safeCutoff(text, boundary);

    this.held = text.slice(cut);
    return this.release(text.slice(0, cut), boundary);
  }

  /**
   * Redacts and returns the remaining buffered text
   */
  flush(boundary?: StreamBoundary): string {
    const text = this.held + this.decoder.end();
    this.held = '';
    return this.release(text, boundary);
  }

  /**
   * Determines how much text can be safely released without splitting
   * a character at the boundary.
   */
  private safeCutoff(text: string, boundary?: StreamBoundary): number {
    const cut = this.ledger.holdFrom(text);

    const splitsCharacterAtBoundary =
      boundary !== undefined &&
      cut === boundary.pendingInputLength &&
      splitsCharacter(text, cut);

    if (splitsCharacterAtBoundary) {
      const firstHalf = text[cut - 1]!;
      const redactedPrefix = this.ledger.redact(text.slice(0, cut));

      // If the first half was redacted, the prefix would end in '>'.
      if (redactedPrefix.endsWith(firstHalf)) {
        return cut - 1;
      }
    }

    return cut;
  }

  /**
   * Redacts text that is safe to release and updates the boundary if provided.
   */
  private release(text: string, boundary: StreamBoundary | undefined): string {
    if (!boundary) return this.ledger.redact(text);

    boundary.outputPrefixLength = 0;
    boundary.pendingInputLength ??= text.length;

    const boundaryOffset = boundary.pendingInputLength;
    if (boundaryOffset === 0) return this.ledger.redact(text);

    boundary.pendingInputLength = Math.max(0, boundaryOffset - text.length);

    if (boundaryOffset >= text.length) {
      const redactedText = this.ledger.redact(text);
      boundary.outputPrefixLength = redactedText.length;
      return redactedText;
    }

    let splitOffset = this.ledger.safeRedactionBoundary(text, boundaryOffset);

    const splitsCharacterAtBoundary =
      splitOffset === boundaryOffset &&
      splitsCharacter(text, boundaryOffset);

    if (splitsCharacterAtBoundary) {
      splitOffset = this.ledger.safeRedactionBoundary(text, boundaryOffset - 1);
    }

    const redactedPrefix = this.ledger.redact(text.slice(0, splitOffset));
    boundary.outputPrefixLength = redactedPrefix.length;

    return redactedPrefix + this.ledger.redact(text.slice(splitOffset));
  }
}

/** Checks whether the offset falls between the two halves of a character. */
function splitsCharacter(text: string, offset: number): boolean {
  return (text.codePointAt(offset - 1) ?? 0) > 0xffff;
}
