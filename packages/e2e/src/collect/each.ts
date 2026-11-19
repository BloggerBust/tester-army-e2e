/** Row handling for `test.each` and `test.for`: the rows check and each row's title. */

import { inspect, types } from 'node:util';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';
import { describeValue } from '@e2e-dev/core/lib/config/validate';

/** The rows a `test.each` or `test.for` call takes: a non-empty array. */
export function readRows(api: string, rows: unknown): readonly unknown[] {
  if (!Array.isArray(rows)) {
    throw new CollectionError(`${api} takes an array of rows, got ${describeValue(rows)}`);
  }
  // Jest and Vitest also take a table as a tagged template, whose strings would pass as rows.
  if (Object.hasOwn(rows, 'raw')) {
    throw new CollectionError(`${api} takes an array of rows, not a template literal table; write each row as an object or an array`);
  }
  if (rows.length === 0) {
    throw new CollectionError(`${api} got no rows; pass at least one`);
  }
  return rows;
}

/**
 * One title token: a printf placeholder, as Vitest and Jest take them, or
 * `$name` / `$name.path`, read from an object row.
 */
const TOKEN = /%[sdifjo#$%]|\$([\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Continue}$]+)*)/gu;

/**
 * The title of the row at `index`, formatted as Vitest formats a
 * `test.each` title, in one pass so a value is never read as a token.
 * `$name` reads an object row and stays as written for any other row.
 * Printf placeholders take an array row's items in order, or the row itself
 * when it is not an array; one with no item left stays as written.
 */
export function formatEachTitle(title: string, row: unknown, index: number): string {
  const items = Array.isArray(row) ? row : [row];
  let next = 0;
  return title.replace(TOKEN, (token: string, key: string | undefined) => {
    if (key !== undefined) return isObjectRow(row) ? display(readPath(row, key)) : token;
    switch (token) {
      case '%%':
        return '%';
      case '%#':
        return String(index);
      case '%$':
        return String(index + 1);
      default:
        break;
    }
    if (next >= items.length) return token;
    const item: unknown = items[next];
    next += 1;
    switch (token) {
      case '%d':
        if (typeof item === 'bigint') return `${item}n`;
        return typeof item === 'symbol' ? 'NaN' : String(Number(item));
      case '%i':
        return typeof item === 'bigint' ? `${item}n` : String(Number.parseInt(String(item)));
      case '%f': {
        const value = typeof item === 'number' ? item : Number.parseFloat(String(item));
        return Object.is(value, -0) ? '-0' : String(value);
      }
      case '%j':
        return json(item, index);
      case '%o':
        return inspected(item);
      default:
        return display(item);
    }
  });
}

function isObjectRow(row: unknown): row is object {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}

function readPath(row: object, key: string): unknown {
  let value: unknown = row;
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * `breakLength` alone still groups long arrays and splits deep objects;
 * `compact: true` keeps them on one line.
 */
const ONE_LINE = { breakLength: Infinity, compact: true, depth: 4 } as const;

/**
 * A value as Node's inspect shows it, on one line: a title is a test id, so
 * it must not break. An Error shows as its name and message, as Vitest shows
 * it, since inspect prints its stack, whose paths differ from one machine to
 * the next. What inspect still breaks (the stack of an Error inside the
 * value, a custom inspect) is joined.
 */
function inspected(value: unknown): string {
  const text = types.isNativeError(value) ? Error.prototype.toString.call(value) : inspect(value, ONE_LINE);
  return text.replace(/\s*\n\s*/g, ' ');
}

/** A string as written, anything else as `inspected` shows it. */
function display(value: unknown): string {
  return typeof value === 'string' ? value : inspected(value);
}

/**
 * `%j`: JSON, `[Circular]` for a circular value, and `undefined` for what
 * JSON leaves out (a function, a Symbol, `undefined`), as Vitest prints them;
 * any other failure names the row.
 */
function json(value: unknown, index: number): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Converting circular structure to JSON')) return '[Circular]';
    const reason = error instanceof Error ? error.message : String(error);
    throw new CollectionError(`%j cannot format the row at index ${index}: ${reason}`);
  }
}
