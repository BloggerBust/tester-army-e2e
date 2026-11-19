/** The fixtures a function names: read from the source of its first parameter, or of the one after a row. */

import { describe, expect, it } from 'vitest';
import { declarationSite } from '../../src/collect/fixture-errors.ts';
import { fixtureNames, type FixtureUserFn } from '../../src/collect/fixture-names.ts';

/** A function built from source, so the test controls exactly what `toString()` prints. */
function written(source: string): FixtureUserFn {
  return new Function(`return (${source});`)() as FixtureUserFn;
}

const names = (fn: FixtureUserFn): readonly string[] => fixtureNames(fn, 'test "x"');

describe('fixtureNames', () => {
  it.each([
    ['an async arrow', 'async ({ app, screen }) => {}', ['app', 'screen']],
    ['an arrow', '({ app }) => app', ['app']],
    ['an arrow with no space after async', 'async({app,screen})=>{}', ['app', 'screen']],
    ['a function expression', 'function ({ app, screen }) {}', ['app', 'screen']],
    ['a named async function', 'async function body({ app }) {}', ['app']],
    ['an async generator function', 'async function* body({ app }) {}', ['app']],
    ['a fixture function', 'async ({ app, database }, use) => { await use(1); }', ['app', 'database']],
    ['renames', '({ app: a, screen: s }) => {}', ['app', 'screen']],
    ['defaults', '({ app = 1, screen = fallback({ a: 1 }, [2, 3]) }) => {}', ['app', 'screen']],
    ['a rename with a default', '({ app: a = {} }) => {}', ['app']],
    ['nested patterns', '({ app: { baseUrl }, screen: [first, { second }] }) => {}', ['app', 'screen']],
    ['a default for the whole parameter', '({ app, screen } = {}) => {}', ['app', 'screen']],
    ['a quoted property', `({ 'app': a, "screen": s }) => {}`, ['app', 'screen']],
    ['a trailing comma and newlines', '({\n  app,\n  screen,\n}) => {}', ['app', 'screen']],
    ['a repeated name', '({ app, app: again }) => {}', ['app']],
    ['a string default holding brackets and commas', `({ app = '}, {', screen = \`\${[1, 2].join(')')}\` }) => {}`, ['app', 'screen']],
    ['line and block comments', '(/* fixtures */ { app, // the app\n /* and */ screen /* too */ }) => {}', ['app', 'screen']],
    ['a comment that looks like a parameter', '/* (fixtures) */ async ({ app }) => {}', ['app']],
    ['only the first parameter', '({ app }, { screen }) => {}', ['app']],
    ['an empty pattern', 'async ({}, use) => { await use(1); }', []],
    ['no parameter', 'async () => {}', []],
    ['no parameter in a function', 'function () { return ({ app }) => app; }', []],
  ])('reads %s', (_, source, expected) => {
    expect(names(written(source))).toEqual(expected);
  });

  it.each([
    ['the parameter after an object row', 'async ({ user }, { app, screen }) => {}', 1, ['app', 'screen']],
    ['the parameter after a spread row', '(a, b = [1, 2], { app }) => {}', 2, ['app']],
    ['no parameter after the row', '({ user }) => {}', 1, []],
    ['no parameter after the row of a bare arrow', 'row => row', 1, []],
    ['no parameter at all', '() => {}', 2, []],
  ])('reads %s', (_, source, position, expected) => {
    expect(fixtureNames(written(source), 'test "x"', undefined, position)).toEqual(expected);
  });

  it.each([
    ['a named parameter', '(row, fixtures) => {}', 1, 'fixtures'],
    ['a rest parameter that takes the fixtures', '(a, ...others) => {}', 2, '...others'],
    ['a rest parameter in place of the row', '(...all) => {}', 1, '...all'],
  ])('refuses %s after the row', (_, source, position, taken) => {
    expect(() => fixtureNames(written(source), 'test "x"', undefined, position)).toThrow(
      expect.objectContaining({
        code: 'COLLECTION_ERROR',
        message: `test "x" must destructure parameter ${position + 1}, where it takes the fixtures, as in ({ app, screen }) => {}; it takes "${taken}". e2e sets up only the fixtures a function names there`,
      }),
    );
  });

  it('says how to wrap a bound function that takes a row first', () => {
    const bound = Function.prototype.bind.call((row: unknown, { app }: { app: unknown }) => [row, app], undefined) as FixtureUserFn;
    expect(() => fixtureNames(bound, 'test "x"', undefined, 1)).toThrow('or wrap it: (row, { app }) => bound(row, { app }). e2e sets up');
    // A spread row hands over one argument per item, and the wrapper passes each on.
    expect(() => fixtureNames(bound, 'test "x"', undefined, 3)).toThrow(
      'or wrap it: (item1, item2, item3, { app }) => bound(item1, item2, item3, { app }). e2e sets up',
    );
  });

  it('reads method shorthand, with a plain, computed, or quoted name', () => {
    const methods = written(`{
      async body({ app }) {},
      plain({ screen }) {},
      async *generator({ app, screen }) {},
      ['computed (name)']({ platform }) {},
      'quoted (name)'({ agent }) {},
    }`) as unknown as Record<string, FixtureUserFn>;
    expect(names(methods['body']!)).toEqual(['app']);
    expect(names(methods['plain']!)).toEqual(['screen']);
    expect(names(methods['generator']!)).toEqual(['app', 'screen']);
    expect(names(methods['computed (name)']!)).toEqual(['platform']);
    expect(names(methods['quoted (name)']!)).toEqual(['agent']);
  });

  it('reads what this file compiles to, type annotations included', () => {
    const typed = async ({ app, screen: renamed }: { app: string; screen: string }): Promise<void> => void [app, renamed];
    expect(names(typed as FixtureUserFn)).toEqual(['app', 'screen']);
  });

  it('refuses a function whose source is not its own, since it would be handed nothing', () => {
    const bound = Function.prototype.bind.call(({ app }: { app: unknown }) => app, undefined) as FixtureUserFn;
    expect(() => names(bound)).toThrow(
      expect.objectContaining({
        code: 'COLLECTION_ERROR',
        message: 'test "x" is a bound or native function, whose parameters cannot be read; pass the function itself, or wrap it: ({ app }) => bound({ app }). e2e sets up only the fixtures a function names there',
      }),
    );
    expect(() => names(Math.max as FixtureUserFn)).toThrow('is a bound or native function');
    // The words in a body or a default value are not the marker.
    expect(names(written(`({ app = '{ [native code] }' }) => { return '{ [native code] }'; }`))).toEqual(['app']);
  });

  it.each([
    ['a named parameter', 'async (fixtures) => {}', 'fixtures'],
    ['a bare arrow parameter', 'fixtures => fixtures', 'fixtures'],
    ['an async bare arrow parameter', 'async fixtures => fixtures', 'fixtures'],
    ['a parameter called async', 'async => async', 'async'],
    ['an ignored first parameter', 'async (_, use) => { await use(1); }', '_'],
    ['an array pattern', '([app]) => app', '[app]'],
    ['a rest parameter', '(...all) => all', '...all'],
    ['a named parameter with a default', '(fixtures = {}) => fixtures', 'fixtures = {}'],
  ])('refuses %s', (_, source, taken) => {
    expect(() => names(written(source))).toThrow(
      expect.objectContaining({
        code: 'COLLECTION_ERROR',
        message: `test "x" must destructure its first parameter, as in ({ app, screen }) => {}; it takes "${taken}". e2e sets up only the fixtures a function names there`,
      }),
    );
  });

  it('refuses a rest property and says to list the fixtures', () => {
    expect(() => names(written('async ({ app, ...rest }) => {}'))).toThrow(
      expect.objectContaining({
        code: 'COLLECTION_ERROR',
        message: 'test "x" takes the rest property "...rest" in its first parameter; list the fixtures it uses by name. e2e sets up only the fixtures a function names there',
      }),
    );
  });

  it('refuses a computed property', () => {
    expect(() => names(written('async ({ [key]: value }) => {}'))).toThrow(
      expect.objectContaining({ message: expect.stringContaining('takes the computed property "[key]: value"') }),
    );
  });

  it('opens the error with the subject it is given', () => {
    const refused = written('(fixtures) => fixtures');
    expect(() => fixtureNames(refused, 'beforeEach hook')).toThrow('beforeEach hook must destructure');
    expect(() => fixtureNames(refused, 'worker fixture "database"')).toThrow('worker fixture "database" must destructure');
  });

  it('carries where the function was registered, which the collector puts before the message', () => {
    const source = { file: '/repo/tests/support.ts', line: 12, column: 3 };
    let thrown: unknown;
    try {
      fixtureNames(written('(fixtures) => fixtures'), 'test "x"', source);
    } catch (cause) {
      thrown = cause;
    }
    expect(declarationSite(thrown, '/repo', 'tests/a.e2e.ts')).toBe('tests/support.ts:12');
    // Declared outside the project, or with no line: the collected file stands.
    expect(declarationSite(thrown, '/elsewhere', 'tests/a.e2e.ts')).toBe('tests/a.e2e.ts');
    expect(declarationSite(new Error('other'), '/repo', 'tests/a.e2e.ts')).toBe('tests/a.e2e.ts');
  });
});
