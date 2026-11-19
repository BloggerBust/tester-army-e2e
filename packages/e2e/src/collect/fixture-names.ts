/**
 * Which fixtures a function names: the properties its first parameter
 * destructures, read from the function's source the way Playwright and
 * Vitest read them. A test body, a hook, and a fixture function each say
 * what they use this way, so the runner sets up those fixtures and no others.
 */

import type { SourceLocation } from '@e2e-dev/core/lib/internal/source';
import { FixtureUseError } from './fixture-errors.ts';

/** Any function that receives fixtures as its first argument. */
export type FixtureUserFn = (...args: never[]) => unknown;

const QUOTES = new Set(['"', "'", '`']);
const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const WORD = /[\p{ID_Continue}$#\u200c\u200d]/u;

/** The index of the first character at or after `at` that is neither whitespace nor inside a comment. */
function skipTrivia(text: string, at: number): number {
  let index = at;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) index += 1;
    else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end + 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else break;
  }
  return index;
}

/** The index after the string or template literal that opens at `at`. */
function skipQuoted(text: string, at: number): number {
  const quote = text[at]!;
  let index = at + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '\\') index += 2;
    else if (char === quote) return index + 1;
    else if (quote === '`' && text.startsWith('${', index)) index = skipGroup(text, index + 1);
    else index += 1;
  }
  return index;
}

/** The index after the bracket group that opens at `at`; nested groups, strings, and comments are stepped over. */
function skipGroup(text: string, at: number): number {
  const closer = CLOSERS[text[at]!]!;
  let index = at + 1;
  while (index < text.length) {
    index = skipTrivia(text, index);
    const char = text[index];
    if (char === undefined) break;
    if (char === closer) return index + 1;
    if (QUOTES.has(char)) index = skipQuoted(text, index);
    else if (char in CLOSERS) index = skipGroup(text, index);
    else index += 1;
  }
  return index;
}

/** `text` split at its top-level commas, comments dropped, each piece trimmed; empty pieces are left out. */
function splitTopLevel(text: string): string[] {
  const pieces: string[] = [];
  let piece = '';
  let index = 0;
  while (index < text.length) {
    const next = skipTrivia(text, index);
    // A comment separates tokens the way the whitespace around it does.
    if (next > index) piece += ' ';
    const char = text[next];
    if (char === undefined) break;
    if (char === ',') {
      pieces.push(piece);
      piece = '';
      index = next + 1;
      continue;
    }
    const end = QUOTES.has(char) ? skipQuoted(text, next) : char in CLOSERS ? skipGroup(text, next) : next + 1;
    piece += text.slice(next, end);
    index = end;
  }
  pieces.push(piece);
  return pieces.map((each) => each.trim()).filter((each) => each !== '');
}

/**
 * The parameter at `position` of a function, as written: `{ app, screen }`.
 * Undefined for a function that takes fewer, and for source with no
 * parameter list to read. A rest parameter at or before `position` is
 * returned as written (`...args`), since it takes that argument too.
 */
function parameterAt(source: string, position: number): string | undefined {
  let index = skipTrivia(source, 0);
  while (index < source.length) {
    const char = source[index]!;
    if (char === '(') {
      const parameters = splitTopLevel(source.slice(index + 1, skipGroup(source, index) - 1));
      const rest = parameters.findIndex((parameter) => parameter.startsWith('...'));
      return rest !== -1 && rest < position ? parameters[rest] : parameters[position];
    }
    // A method's name may be computed or quoted: `['a b']({ app }) {}`.
    if (char === '[') index = skipGroup(source, index);
    else if (QUOTES.has(char)) index = skipQuoted(source, index);
    else if (char === '*') index += 1;
    else if (WORD.test(char)) {
      let end = index;
      while (end < source.length && WORD.test(source[end]!)) end += 1;
      const after = skipTrivia(source, end);
      // An arrow function with one bare parameter has no parentheses: `fixtures => {}`.
      if (source.startsWith('=>', after)) return position === 0 ? source.slice(index, end) : undefined;
      index = end;
    } else return undefined;
    index = skipTrivia(source, index);
  }
  return undefined;
}

/** The name one property of a destructuring pattern reads: `a`, `a: b`, `a = 1`, `'a': b`, `a: { nested }`. */
function propertyName(property: string): string {
  if (QUOTES.has(property[0]!)) return property.slice(1, skipQuoted(property, 0) - 1);
  return /^[^\s:=]+/u.exec(property)?.[0] ?? property;
}

const WHY = 'e2e sets up only the fixtures a function names there';
/** What `Function.prototype.toString` prints for a function with no source of its own. */
const NATIVE = /\{\s*\[native code\]\s*\}\s*$/;

/**
 * The fixtures `fn` names in its first parameter, or in the parameter at
 * `position` for a `test.each` body, which takes the row first. Registration
 * calls it once per function and keeps the result beside the function
 * (`names`). A function with no parameter there names none. One that takes the whole fixture
 * object (`(fixtures) => {}`), a rest property (`{ app, ...rest }`), or a
 * computed property fails with a `COLLECTION_ERROR` that opens with `what`
 * (`test "signs in"`, `beforeEach hook`, `fixture "database"`) and carries
 * `source`, the line the function was registered at.
 */
export function fixtureNames(fn: FixtureUserFn, what: string, source?: SourceLocation, position = 0): readonly string[] {
  const where = position === 0 ? 'its first parameter' : `parameter ${position + 1}, where it takes the fixtures`;
  const refuse = (problem: string): FixtureUseError => new FixtureUseError(`${what} ${problem}. ${WHY}`, source);
  const text = Function.prototype.toString.call(fn);
  // A bound or built-in function prints no parameters, so it would be handed no fixtures at all.
  if (NATIVE.test(text)) {
    // One argument per item of a spread row comes before the fixtures.
    const row = position === 1 ? ['row'] : Array.from({ length: position }, (_, index) => `item${index + 1}`);
    const taken = [...row, '{ app }'].join(', ');
    throw refuse(`is a bound or native function, whose parameters cannot be read; pass the function itself, or wrap it: (${taken}) => bound(${taken})`);
  }
  const parameter = parameterAt(text, position);
  if (parameter === undefined) return [];
  if (!parameter.startsWith('{')) {
    const shown = parameter.length > 40 ? `${parameter.slice(0, 40)}...` : parameter;
    throw refuse(`must destructure ${where}, as in ({ app, screen }) => {}; it takes "${shown}"`);
  }
  const names: string[] = [];
  for (const property of splitTopLevel(parameter.slice(1, skipGroup(parameter, 0) - 1))) {
    if (property.startsWith('...')) throw refuse(`takes the rest property "${property}" in ${where}; list the fixtures it uses by name`);
    if (property.startsWith('[')) throw refuse(`takes the computed property "${property}" in ${where}; write the fixture's name`);
    names.push(propertyName(property));
  }
  return [...new Set(names)];
}
