import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { collectFromRegistration } from '../../src/collect/collect.ts';
import * as registry from '../../src/collect/registry.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';

const noop = async () => {};

describe('registration', () => {
  it('registers tests synchronously in declaration order', async () => {
    const registration = await collectModule(async () => {
      test('first', noop);
      test('second', { tags: ['smoke'] }, noop);
    });
    expect(registration.tests.map((item) => item.title)).toEqual(['first', 'second']);
    expect(registration.tests[0]!.declarationIndex).toBeLessThan(
      registration.tests[1]!.declarationIndex,
    );
  });

  it('returns a branded TestCase and ignores it for discovery', async () => {
    const registration = await collectModule(async () => {
      const testCase = test('kept once', noop);
      expect(testCase).toBeDefined();
    });
    expect(registration.tests).toHaveLength(1);
  });

  it('rejects tags that are not a list of distinct names --tag can spell back', async () => {
    const register = (tags: unknown) =>
      collectModule(async () => {
        test('x', { tags } as never, noop);
      });
    await expect(register('smoke')).rejects.toThrow(
      "test options: tags must be a list of tag names, e.g. tags: ['smoke'], got \"smoke\"",
    );
    await expect(register({ smoke: true })).rejects.toThrow(/tags must be a list of tag names, .* got an object/);
    const rule = 'every tag must be a non-blank string with no comma and no leading or trailing whitespace';
    for (const [tag, shown] of [[1, '1'], ['', '""'], [' smoke', '" smoke"'], ['a,b', '"a,b"'], [undefined, 'undefined']] as const) {
      await expect(register([tag])).rejects.toThrow(`test options: ${rule}, got ${shown}`);
    }
    await expect(register(['smoke', 'smoke'])).rejects.toThrow('test options: tags lists "smoke" twice');
    await expect(
      collectModule(async () => {
        test.describe('group', { tags: ['a,b'] }, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow(`describe options: ${rule}`);
    // Inner spaces are legal: `--tag 'Login Form'` spells this back.
    const registration = await collectModule(async () => {
      test('x', { tags: ['smoke', 'Login Form', 'billing:refunds', 'v2.0'] }, noop);
    });
    expect(registration.tests[0]!.options.tags).toEqual(['smoke', 'Login Form', 'billing:refunds', 'v2.0']);
  });

  it('rejects a timeout a timer cannot wait for', async () => {
    const registration = await collectModule(async () => {
      test('x', { timeout: 2 ** 31 - 1 }, noop);
    });
    expect(registration.tests[0]!.options.timeout).toBe(2 ** 31 - 1);
    await expect(
      collectModule(async () => {
        test('x', { timeout: 2 ** 31 }, noop);
      }),
    ).rejects.toThrow('test options: timeout must be at most 2147483647 milliseconds, got 2147483648');
    await expect(
      collectModule(async () => {
        test.describe('group', { timeout: 3_000_000_000 }, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow('describe options: timeout must be at most 2147483647 milliseconds, got 3000000000');
  });

  it('rejects an option key test, describe, or setup does not know, naming the nearest', async () => {
    const register = (declare: () => void) => collectModule(async () => declare());
    await expect(register(() => test('x', { timout: 1000, retry: 2 } as never, noop))).rejects.toThrow(
      'test options has unknown key "timout"; did you mean "timeout"?',
    );
    await expect(register(() => test('x', { retry: 2 } as never, noop))).rejects.toThrow(
      'test options has unknown key "retry"; expected one of timeout, retries, tags, skip, fail, only, platforms, session, agentContext, agent, trace, video',
    );
    await expect(register(() => test('x', { requires: ['browser'] } as never, noop))).rejects.toThrow(
      "test options: requires was removed; scope the test to targets with platforms, e.g. platforms: ['web']",
    );
    await expect(register(() => test.describe('group', { searial: true } as never, () => {}))).rejects.toThrow(
      'describe options has unknown key "searial"; did you mean "serial"?',
    );
    await expect(register(() => test.setup('login', { sessions: ['admin'], tag: ['auth'] } as never, noop))).rejects.toThrow(
      'setup options has unknown key "tag"; did you mean "tags"?',
    );
    await expect(register(() => test.setup('login', { sessions: ['admin'], skip: true } as never, noop))).rejects.toThrow(
      /^setup options has unknown key "skip"; expected one of timeout, retries, tags, platforms/,
    );
  });

  it('rejects registration outside collection', () => {
    expect(() => test('orphan', noop)).toThrow(/collected by the e2e runner/);
  });

  it('rejects registration after module evaluation (timers, promises)', async () => {
    let late: (() => void) | undefined;
    await collectModule(async () => {
      test('on time', noop);
      late = () => test('too late', noop);
    });
    expect(late!).toThrow(/after module evaluation|collected by the e2e runner/);
  });

  it('describe nests titles and must be synchronous', async () => {
    const registration = await collectModule(async () => {
      test.describe('outer', () => {
        test.describe('inner', () => {
          test('leaf', noop);
        });
      });
    });
    expect(registration.tests[0]!.titlePath).toEqual(['outer', 'inner', 'leaf']);
  });

  it('registers through the top-level describe and hooks as through test.*', async () => {
    const registration = await collectModule(async () => {
      registry.beforeAll(noop);
      registry.describe('outer', { tags: ['smoke'] }, () => {
        registry.beforeEach(noop);
        test('leaf', noop);
        registry.afterEach(noop);
      });
      registry.afterAll(noop);
    });
    expect(registration.tests[0]).toMatchObject({ titlePath: ['outer', 'leaf'], tags: ['smoke'] });
    expect(registration.hooks.map((hook) => [hook.kind, hook.group?.title])).toEqual([
      ['beforeAll', undefined],
      ['beforeEach', 'outer'],
      ['afterEach', 'outer'],
      ['afterAll', undefined],
    ]);
    expect(() => registry.describe('late', () => {})).toThrow(/describe\(\) can only be called while a test module is being collected/);
  });

  it('rejects async describe bodies', async () => {
    await expect(
      collectModule(async () => {
        test.describe('bad', (async () => {}) as never);
      }),
    ).rejects.toThrow(/synchronously/);
  });

  it('records skip modes, and test.only as the only option', async () => {
    const registration = await collectModule(async () => {
      test.skip('skipped', noop);
      test.only('focused', noop);
      test('opt-skip', { skip: 'flaky upstream' }, noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.options.only])).toEqual([['skip', undefined], ['normal', true], ['skip', undefined]]);
    expect(registration.tests[2]!.options.skip).toBe('flaky upstream');
  });

  it('registers test.skipIf and test.runIf tests skipped or normal by the condition read at the call', async () => {
    const registration = await collectModule(async () => {
      test.skipIf(true)('skipIf true', noop);
      test.skipIf(false)('skipIf false', noop);
      test.runIf(true)('runIf true', noop);
      test.runIf(false)('runIf false', noop);
      test.skipIf('linux')('truthy string', noop);
      test.runIf(0)('falsy number', noop);
      test.skipIf(undefined)('skipIf undefined', noop);
      test.skipIf(0)('skipIf zero', noop);
      test.skipIf('')('skipIf empty string', noop);
      test.runIf('linux')('runIf truthy string', noop);
      test.runIf(undefined)('runIf undefined', noop);
    });
    expect(registration.tests.map((item) => [item.title, item.mode, item.options.skip])).toEqual([
      ['skipIf true', 'skip', true],
      ['skipIf false', 'normal', undefined],
      ['runIf true', 'normal', undefined],
      ['runIf false', 'skip', true],
      ['truthy string', 'skip', true],
      ['falsy number', 'skip', true],
      ['skipIf undefined', 'normal', undefined],
      ['skipIf zero', 'normal', undefined],
      ['skipIf empty string', 'normal', undefined],
      ['runIf truthy string', 'normal', undefined],
      ['runIf undefined', 'skip', true],
    ]);
    expect(() => test.skipIf(true)('outside', noop)).toThrow(/^test\.skipIf\(\) /);
    expect(() => test.runIf(true)('outside', noop)).toThrow(/^test\.runIf\(\) /);
  });

  it('rejects a Promise condition, which would always read as truthy', async () => {
    expect(() => test.skipIf(Promise.resolve(false) as unknown)).toThrow(
      'test.skipIf() got a Promise as its condition; await it before the call',
    );
    expect(() => test.runIf(Promise.resolve(true) as unknown)).toThrow(
      'test.runIf() got a Promise as its condition; await it before the call',
    );
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable that is not a Promise is the case under test
    const thenable = { then: (resolve: (value: boolean) => void) => resolve(false) };
    expect(() => test.skipIf(thenable)).toThrow(
      'test.skipIf() got a Promise as its condition; await it before the call',
    );
  });

  it('keeps the options of a test.skipIf test, its skip reason included', async () => {
    const registration = await collectModule(async () => {
      test.skipIf(true)('tagged', { tags: ['@fs'], timeout: 5000 }, noop);
      test.skipIf(true)('with reason', { skip: 'no inotify on macOS' }, noop);
      test.skipIf(true)('empty reason', { skip: '' }, noop);
      test.skipIf(true)('skip false', { skip: false }, noop);
      test.skipIf(true)('focused', { only: true }, noop);
      test.skipIf(false)('not skipped', { tags: ['@fs'] }, noop);
      test.skipIf(false)('option reason, falsy skipIf', { skip: 'tracked in #42' }, noop);
      test.runIf(true)('option reason, truthy runIf', { skip: 'tracked in #42' }, noop);
      test.skipIf(false)('option true, falsy skipIf', { skip: true }, noop);
      test.runIf(true)('option true, truthy runIf', { skip: true }, noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.options, item.tags])).toEqual([
      ['skip', { tags: ['@fs'], timeout: 5000, skip: true }, ['@fs']],
      ['skip', { skip: 'no inotify on macOS' }, []],
      ['skip', { skip: '' }, []],
      ['skip', { skip: true }, []],
      ['skip', { only: true, skip: true }, []],
      ['normal', { tags: ['@fs'] }, ['@fs']],
      ['skip', { skip: 'tracked in #42' }, []],
      ['skip', { skip: 'tracked in #42' }, []],
      ['skip', { skip: true }, []],
      ['skip', { skip: true }, []],
    ]);
    await expect(collectModule(async () => test.skipIf(true)('bad', { retry: 1 } as never, noop))).rejects.toThrow(
      /test options has unknown key "retry"/,
    );
    await expect(collectModule(async () => test.skipIf(true)('no body', {} as never))).rejects.toThrow(
      'test body function is required',
    );
  });

  it('registers one test.each test per row, in row order, titled from the row', async () => {
    const registration = await collectModule(async () => {
      test.each([{ user: 'Ada', plan: { name: 'pro' } }, { user: 'Grace', plan: { name: 'free' } }])(
        'signs in as $user on $plan.name',
        noop,
      );
      test.each([[1, 2, 3], [2, 2, 4]])('%i + %i = %d', noop);
      test.each(['a', 'b'])('row %# of letter %s, number %$', noop);
      test.for([[1, { a: 'x' }]])('%i and %j via test.for, title as in test.each', noop);
      test.each([{ a: [1, 2] }])('%o', noop);
      test.each([{ id: 1 }])('$missing $id.deep %s 100%% %s', noop);
      test.each([7])('only $user stays as written', noop);
      test.each([{ text: '%s and $id', id: 9 }])('$text is not read again', noop);
      test.each([['42px', '1.5e3', '2.5kg', 1e21]])('%i %f %f %i', noop);
      test.each([[Symbol('s'), Symbol('t'), Symbol('u')]])('%d %i %f', noop);
      test.each([[[1, 2, 3, 4, 5, 6, 7]]])('ids %s', noop);
      test.each([{ tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], deep: { a: { b: { c: { d: 1 } } } } }])('$tags %o', noop);
      test.each([[-0, '-0']])('%f %f', noop);
      test.each([[function named(a: unknown) {
        return a;
      }, Symbol('s'), undefined]])('%j %j %j', noop);
      test.each([{ 名前: 'Ada', ユーザー: { 名: 'L' } }])('$名前 $ユーザー.名', noop);
      test.each([[new Error('boom'), new TypeError('bad')]])('%s %o', noop);
      test.each([{ error: new RangeError('too far') }])('fails with $error', noop);
      const inner = new Error('inner');
      inner.stack = 'Error: inner\n    at somewhere (file.js:1:1)';
      test.each([[{ cause: inner }, Symbol('a\nb')]])('%s %s', noop);
    });
    expect(registration.tests.map((item) => [item.title, item.mode])).toEqual([
      ['signs in as Ada on pro', 'normal'],
      ['signs in as Grace on free', 'normal'],
      ['1 + 2 = 3', 'normal'],
      ['2 + 2 = 4', 'normal'],
      ['row 0 of letter a, number 1', 'normal'],
      ['row 1 of letter b, number 2', 'normal'],
      ['1 and {"a":"x"} via test.for, title as in test.each', 'normal'],
      ['{ a: [ 1, 2 ] }', 'normal'],
      ['undefined undefined { id: 1 } 100% %s', 'normal'],
      ['only $user stays as written', 'normal'],
      ['%s and $id is not read again', 'normal'],
      ['42 1500 2.5 1', 'normal'],
      ['NaN NaN NaN', 'normal'],
      ['ids [ 1, 2, 3, 4, 5, 6, 7 ]', 'normal'],
      ["[ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ] { tags: [ 'a', 'b', 'c', 'd', 'e', 'f', 'g' ], deep: { a: { b: { c: { d: 1 } } } } }", 'normal'],
      ['-0 -0', 'normal'],
      ['undefined undefined undefined', 'normal'],
      ['Ada L', 'normal'],
      ['Error: boom TypeError: bad', 'normal'],
      ['fails with RangeError: too far', 'normal'],
      ['{ cause: Error: inner at somewhere (file.js:1:1) } Symbol(a b)', 'normal'],
    ]);
    const indexes = registration.tests.map((item) => item.declarationIndex);
    expect(indexes).toEqual(indexes.toSorted((a, b) => a - b));
  });

  it('spreads test.each rows before the fixtures only when every row is an array, and passes test.for rows whole', async () => {
    const calls: unknown[][] = [];
    const spread = async (n: unknown, word: unknown, { app }: { app: unknown }) => {
      calls.push([n, word, { app }]);
    };
    const whole = async (row: unknown, { app }: { app: unknown }) => {
      calls.push([row, { app }]);
    };
    const registration = await collectModule(async () => {
      test.each([[1, 'one'], [2, 'two']])('each %#', spread as never);
      test.each([[1, 'one'], { user: 'Ada' }, 'plain'])('mixed %#', whole as never);
      test.for([[1, 'one'], { user: 'Ada' }])('for %#', whole as never);
    });
    expect(registration.tests.map((item) => item.names)).toEqual(Array.from({ length: 7 }, () => ['app']));
    const fixtures = { app: 'app fixture' };
    for (const registered of registration.tests) await (registered.fn as (fixtures: unknown) => Promise<void>)(fixtures);
    expect(calls).toEqual([
      [1, 'one', fixtures],
      [2, 'two', fixtures],
      [[1, 'one'], fixtures],
      [{ user: 'Ada' }, fixtures],
      ['plain', fixtures],
      [[1, 'one'], fixtures],
      [{ user: 'Ada' }, fixtures],
    ]);
  });

  it('reads a test.each body\'s fixtures from the parameter after the row', async () => {
    const registration = await collectModule(async () => {
      test.each([[1, 2]])('spread %#', async (_a: number, _b: number, { app, screen }: { app: unknown; screen: unknown }) => {
        void app;
        void screen;
      });
      test.each([{ user: 'Ada' }])('object %#', async ({ user }: { user: string }, { app }: { app: unknown }) => {
        void user;
        void app;
      });
      test.for([[1, 2]])('for %#', async ([a]: number[], { screen }: { screen: unknown }) => {
        void a;
        void screen;
      });
      test.each([1])('no fixtures %#', async (_n: number) => {});
    });
    expect(registration.tests.map((item) => [item.title, item.names])).toEqual([
      ['spread 0', ['app', 'screen']],
      ['object 0', ['app']],
      ['for 0', ['screen']],
      ['no fixtures 0', []],
    ]);
    await expect(collectModule(async () => {
      test.each([[1, 2]])('whole %#', async (_a: number, _b: number, fixtures: unknown) => {
        void fixtures;
      });
    })).rejects.toThrow(/test "whole 0" must destructure parameter 3, where it takes the fixtures, as in \(\{ app, screen \}\) => \{\}; it takes "fixtures"/);
    await expect(collectModule(async () => {
      test.each([[1, 2]])('rest %#', async (...args: unknown[]) => {
        void args;
      });
    })).rejects.toThrow(/test "rest 0" must destructure parameter 3, where it takes the fixtures.*it takes "\.\.\.args"/);
    // Each row is spread on its own, so a row with fewer items puts the fixtures in a parameter that names an item.
    await expect(collectModule(async () => {
      test.each([[1, 2], [3]] as number[][])('short %#', (async (a: number, b: number, { app }: { app: unknown }) => void [a, b, app]) as never);
    })).rejects.toThrow(/test "short 1" must destructure parameter 2, where it takes the fixtures.*it takes "b"/);
  });

  it('applies test.each options to every row and works on an extended test', async () => {
    const extended = test.extend({ workspace: async ({}, use: (value: string) => Promise<void>) => use('w') });
    const registration = await collectModule(async () => {
      test.each([1, 2])('skipped %s', { skip: 'not yet', tags: ['@each'] }, noop);
      test.for([1])('focused %s', { only: true }, noop);
      extended.each([1])('extended %s', noop);
    });
    expect(
      registration.tests.map((item) => [item.title, item.mode, item.options, item.tags, item.fixtures.map((definition) => definition.name)]),
    ).toEqual([
      ['skipped 1', 'skip', { skip: 'not yet', tags: ['@each'] }, ['@each'], []],
      ['skipped 2', 'skip', { skip: 'not yet', tags: ['@each'] }, ['@each'], []],
      ['focused 1', 'normal', { only: true }, [], []],
      ['extended 1', 'normal', {}, [], ['workspace']],
    ]);
  });

  it('rejects test.each and test.for rows that are not a non-empty array, and bad calls', async () => {
    expect(() => test.each('ab' as never)).toThrow('test.each() takes an array of rows, got "ab"');
    expect(() => test.for(undefined as never)).toThrow(/^test\.for\(\) takes an array of rows, got undefined/);
    expect(() => test.each([])).toThrow('test.each() got no rows; pass at least one');
    expect(() => test.for([])).toThrow('test.for() got no rows; pass at least one');
    const tagged = test.each as unknown as (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
    expect(() => tagged`a | b\n${1} | ${2}`).toThrow('test.each() takes an array of rows, not a template literal table');
    // Only a template's own `raw` marks it: one the rows inherit does not.
    const inherits: number[] = Object.setPrototypeOf([1], Object.create(Array.prototype, { raw: { value: [] } }));
    expect(() => test.each(inherits)).not.toThrow();
    expect(() => test.each([1])('outside %s', noop)).toThrow(/^test\.each\(\) /);
    await expect(collectModule(async () => test.each([1])('no body %s', {} as never))).rejects.toThrow(
      'test body function is required',
    );
    await expect(collectModule(async () => test.each([1])('bad', { retry: 1 } as never, noop))).rejects.toThrow(
      /test options has unknown key "retry"/,
    );
    await expect(collectModule(async () => test.each([[1], [2n]])('%j', noop))).rejects.toThrow(
      /^%j cannot format the row at index 1: Do not know how to serialize a BigInt/,
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const formatted = await collectModule(async () => {
      test.each([[circular]])('%j', noop);
    });
    expect(formatted.tests.map((item) => item.title)).toEqual(['[Circular]']);
    const own = { toJSON: () => { throw new TypeError('circular reference in my model'); } };
    await expect(collectModule(async () => test.each([[own]])('%j', noop))).rejects.toThrow(
      /^%j cannot format the row at index 0: circular reference in my model/,
    );
    const same = await collectModule(async () => {
      test.each([1, 2])('same title', noop);
    });
    expect(() => collectFromRegistration('/root', '/root/tests/each.e2e.ts', same)).toThrow(
      'duplicate title path same title in tests/each.e2e.ts',
    );
  });

  it('rejects test.skipIf and test.runIf in a serial group whatever the condition', async () => {
    const calls: Array<[string, () => void]> = [
      ['test.skipIf()', () => test.skipIf(true)('member', noop)],
      ['test.skipIf()', () => test.skipIf(false)('member', noop)],
      ['test.runIf()', () => test.runIf(true)('member', noop)],
      ['test.runIf()', () => test.runIf(false)('member', noop)],
    ];
    for (const [api, call] of calls) {
      await expect(
        collectModule(async () => {
          test.describe('unit', { serial: true }, () => {
            test.describe('nested', call);
          });
        }),
      ).rejects.toThrow(`${api} cannot be used inside a serial group, which skips as one unit; set skip on the serial describe instead`);
    }
    const registration = await collectModule(async () => {
      test.describe('plain group', () => {
        test.runIf(true)('member', noop);
      });
    });
    expect(registration.tests.map((item) => item.mode)).toEqual(['normal']);
  });

  it('registers test.fixme(title, fn) as fixme with the reason fixme, and rejects it in a serial group', async () => {
    const registration = await collectModule(async () => {
      test.fixme('not yet', noop);
      test.describe('plain group', () => {
        test.fixme('grouped', noop);
      });
    });
    expect(registration.tests.map((item) => [item.title, item.mode, item.options])).toEqual([
      ['not yet', 'fixme', { skip: 'fixme' }],
      ['grouped', 'fixme', { skip: 'fixme' }],
    ]);
    await expect(
      collectModule(async () => {
        test.describe('unit', { serial: true }, () => {
          test.describe('nested', () => {
            test.fixme('member', noop);
          });
        });
      }),
    ).rejects.toThrow('test.fixme() cannot be used inside a serial group, which skips as one unit; set skip on the serial describe instead');
    expect(() => test.fixme('outside', noop)).toThrow(/^test\.fixme\(\) can only be called while a test module is being collected/);
  });

  it('registers test.todo(title) as a todo skip and rejects a body or serial registration', async () => {
    const registration = await collectModule(async () => {
      test.todo('not yet');
    });
    expect(registration.tests.map((item) => [item.title, item.mode, item.options])).toEqual([
      ['not yet', 'todo', { skip: 'todo' }],
    ]);
    await expect(
      collectModule(async () => {
        test.describe('unit', { serial: true }, () => test.todo('member'));
      }),
    ).rejects.toThrow('test.todo() cannot be used inside a serial group');
    await expect(
      collectModule(async () => {
        Reflect.apply(test.todo, test, ['has a body', noop]);
      }),
    ).rejects.toThrow('test.todo() takes a title only; register a test with a body through test.skip(title, fn) or test.fixme(title, fn)');
    expect(() => test.todo('outside')).toThrow(/^test\.todo\(\) can only be called while a test module is being collected/);
  });

  it('rejects test.skip(title, fn) in a serial group, naming test.skip()', async () => {
    await expect(
      collectModule(async () => {
        test.describe('unit', { serial: true }, () => {
          test.describe('nested', () => {
            test.skip('member', noop);
          });
        });
      }),
    ).rejects.toThrow('test.skip() cannot be used inside a serial group, which skips as one unit; set skip on the serial describe instead');
  });

  it('rejects the runtime test.fixme forms outside a test body, pointing at test.fixme(title, fn)', async () => {
    const message =
      'test.fixme(condition, reason) skips the running test and must be called inside a test body; to mark a test fixme at collection, register it with test.fixme(title, fn)';
    await expect(collectModule(async () => test.fixme(true, 'flaky on webkit'))).rejects.toThrow(message);
    await expect(collectModule(async () => test.fixme(false))).rejects.toThrow(message);
    await expect(collectModule(async () => test.fixme('flaky on webkit'))).rejects.toThrow(message);
    await expect(collectModule(async () => test.fixme())).rejects.toThrow(CollectionError);
  });

  it('registers expected failures by test.fail(title, fn) and the fail option, and checks the option', async () => {
    const registration = await collectModule(async () => {
      test.fail('registered', noop);
      test('by option', { fail: 'known gap' }, noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.options.fail])).toEqual([
      ['normal', true],
      ['normal', 'known gap'],
    ]);
    await expect(collectModule(async () => test('bad', { fail: 1 } as never, noop))).rejects.toThrow(
      'test options: fail must be true, false, or a reason string, got 1',
    );
    await expect(collectModule(async () => test.setup('login', { sessions: ['admin'], fail: true } as never, noop))).rejects.toThrow(/unknown key "fail"/);
  });

  it('marks a group by describe.fail(title, fn) or the fail option, and checks both', async () => {
    const registration = await collectModule(async () => {
      test.describe.fail('shortcut', () => test('a', noop));
      test.describe.fail('shortcut with options', { tags: ['legacy'] }, () => test('b', noop));
      test.describe('by option', { fail: 'known gap' }, () => test('c', noop));
      registry.describe.fail('top-level import', () => test('d', noop));
    });
    expect(registration.tests.map((item) => item.group?.options.fail)).toEqual([true, true, 'known gap', true]);
    expect(registration.tests[1]!.tags).toEqual(['legacy']);
    await expect(collectModule(async () => test.describe('group', { fail: 1 } as never, () => {}))).rejects.toThrow(
      'describe options: fail must be true, false, or a reason string, got 1',
    );
    // describe.fail rejects what describe() rejects, including keys a spread would drop.
    const hidden = Object.defineProperty({}, 'bogus', { value: 1, enumerable: false });
    for (const [options, message] of [[[], 'unknown key "length"'], [hidden, 'unknown key "bogus"']] as const) {
      await expect(collectModule(async () => test.describe('group', options as never, () => {}))).rejects.toThrow(message);
      await expect(collectModule(async () => test.describe.fail('group', options as never, () => {}))).rejects.toThrow(message);
    }
    for (const fail of ['legacy checkout', false, 1]) {
      await expect(collectModule(async () => test.describe.fail('group', { fail } as never, () => {}))).rejects.toThrow(
        "describe.fail() takes no fail option; give a reason with describe(title, { fail: 'reason' }, fn)",
      );
    }
  });

  it('marks a group focused by describe.only(title, fn) or the only option, and checks both', async () => {
    const registration = await collectModule(async () => {
      test.describe.only('shortcut', () => test('a', noop));
      test.describe.only('shortcut with options', { tags: ['smoke'] }, () => test('b', noop));
      test.describe('by option', { only: true }, () => test('c', noop));
      registry.describe.only('top-level import', () => test('d', noop));
    });
    expect(registration.tests.map((item) => [item.title, item.group?.options.only, item.mode])).toEqual([
      ['a', true, 'normal'],
      ['b', true, 'normal'],
      ['c', true, 'normal'],
      ['d', true, 'normal'],
    ]);
    expect(registration.tests[1]!.tags).toEqual(['smoke']);
    await expect(collectModule(async () => test.describe('group', { only: 'yes' } as never, () => {}))).rejects.toThrow(
      'describe options: only must be true or false, got "yes"',
    );
    await expect(collectModule(async () => test('x', { only: 'yes' } as never, noop))).rejects.toThrow(
      'test options: only must be true or false, got "yes"',
    );
    // describe.only rejects what describe() rejects, including keys a spread would drop.
    const hidden = Object.defineProperty({}, 'bogus', { value: 1, enumerable: false });
    await expect(collectModule(async () => test.describe.only('group', hidden as never, () => {}))).rejects.toThrow('unknown key "bogus"');
    for (const only of [true, false]) {
      await expect(collectModule(async () => test.describe.only('group', { only } as never, () => {}))).rejects.toThrow(
        'describe.only() takes no only option; it focuses the group already',
      );
    }
  });

  it('refuses only inside a serial group', async () => {
    const insideRule = 'describe option "only" cannot be set inside a serial group, which runs as one unit; focus the serial group instead';
    await expect(
      collectModule(async () => test.describe('unit', { serial: true }, () => test.describe.only('inner', () => {}))),
    ).rejects.toThrow(insideRule);
    await expect(
      collectModule(async () => test.describe('unit', { serial: true }, () => test.describe('inner', { only: true }, () => {}))),
    ).rejects.toThrow(insideRule);
  });

  it('refuses fail on, inside, or around a serial group', async () => {
    const serialRule = 'describe option "fail" cannot be set on or inside a serial group, which runs as one unit';
    await expect(collectModule(async () => test.describe('unit', { serial: true, fail: true }, () => {}))).rejects.toThrow(serialRule);
    await expect(collectModule(async () => test.describe.fail('unit', { serial: true }, () => {}))).rejects.toThrow(serialRule);
    await expect(
      collectModule(async () => test.describe('unit', { serial: true }, () => test.describe.fail('inner', () => {}))),
    ).rejects.toThrow(serialRule);
    await expect(
      collectModule(async () => test.describe.fail('outer', () => test.describe('unit', { serial: true }, () => {}))),
    ).rejects.toThrow('a serial group cannot sit inside a group marked fail; its members cannot be expected to fail');
    await expect(
      collectModule(async () => test.describe('outer', { fail: false }, () => test.describe('unit', { serial: true }, () => {}))),
    ).resolves.toBeDefined();
  });

  it('rejects test.fail(condition) outside a test body', async () => {
    expect(() => test.fail(true, 'not here')).toThrow(CollectionError);
    expect(() => test.fail(false)).toThrow(/must be called inside a test body/);
    expect(() => test.fail(false)).toThrow(/describe\.fail\(title, fn\).*test or describe option/);
  });

  it('validates titles', async () => {
    await expect(
      collectModule(async () => {
        test('', noop);
      }),
    ).rejects.toThrow(/1 through 512/);
  });

  it('validates retries bounds', async () => {
    await expect(
      collectModule(async () => {
        test('x', { retries: 11 }, noop);
      }),
    ).rejects.toThrow(/0 through 10/);
  });

  it.each(['trace', 'video'] as const)('accepts a %s mode on tests, groups, and setups, and rejects anything else', async (kind) => {
    const registration = await collectModule(async () => {
      test.setup('auth', { sessions: ['a'], [kind]: 'off' }, noop);
      test.describe('group', { [kind]: 'on' }, () => {
        test('x', { [kind]: 'on-all-retries' }, noop);
      });
    });
    expect(registration.tests.map((item) => item.options[kind])).toEqual(['off', 'on-all-retries']);
    const register = (mode: unknown) =>
      collectModule(async () => {
        test('x', { [kind]: mode } as never, noop);
      });
    const modes = 'off, on, retain-on-failure, on-first-retry, on-all-retries';
    await expect(register(true)).rejects.toThrow(`test options: ${kind} must be one of ${modes}, got true`);
    await expect(register('on-failure')).rejects.toThrow('got "on-failure"');
    await expect(
      collectModule(async () => {
        test.describe('group', { [kind]: 'yes' } as never, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow(`describe options: ${kind} must be one of ${modes}, got "yes"`);
  });
});

describe('the fixtures a registration names', () => {
  const whole = (async (fixtures: object) => void fixtures) as never;

  it('refuses a test body or a hook that takes the whole fixture object, at the line it is registered on', async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const failure = async (register: () => void): Promise<{ message: string; declaredAt?: { file: string; line: number } }> =>
      collectModule(async () => register(), thisFile).then(
        () => {
          throw new Error('registered');
        },
        (cause: unknown) => cause as { message: string; declaredAt?: { file: string; line: number } },
      );
    const body = await failure(() => test.describe('group', () => void test('takes it all', whole)));
    expect(body.message).toContain('test "group > takes it all" must destructure its first parameter');
    expect(body.declaredAt?.file).toBe(thisFile);
    expect(body.declaredAt?.line).toBeGreaterThan(1);
    expect((await failure(() => test.setup('auth', { sessions: ['member'] }, whole))).message).toContain('setup test "auth" must destructure');
    expect((await failure(() => test.skip('skipped', whole))).message).toContain('test "skipped" must destructure');
    for (const kind of ['beforeEach', 'afterEach', 'beforeAll', 'afterAll'] as const) {
      const hook = await failure(() => test[kind](whole));
      expect(hook.message).toContain(`${kind} hook must destructure its first parameter`);
      expect(hook.declaredAt?.file).toBe(thisFile);
    }
    const rest = await failure(() => test('rest', (async ({ ...all }: object) => void all) as never));
    expect(rest.message).toContain('test "rest" takes the rest property "...all"');
  });

  it('puts the stack trace limit back when reading the stack throws', async () => {
    const limit = Error.stackTraceLimit;
    const prepare = Error.prepareStackTrace;
    Error.prepareStackTrace = () => {
      throw new RangeError('no stack');
    };
    try {
      await expect(collectModule(async () => void test('x', noop))).rejects.toThrow('no stack');
      expect(Error.stackTraceLimit).toBe(limit);
    } finally {
      Error.prepareStackTrace = prepare;
      Error.stackTraceLimit = limit;
    }
  });

  it('records where a hook was registered', async () => {
    const registration = await collectModule(async () => {
      test.beforeEach(async ({ app }) => void app);
    }, fileURLToPath(import.meta.url));
    expect(registration.hooks[0]!.source?.file).toBe(fileURLToPath(import.meta.url));
  });
});

describe('declaration sites from a JavaScriptCore stack', () => {
  const file = path.join(os.tmpdir(), 'declared.e2e.ts');

  /** Collects one test declared in `file` while every stack reads as `frames`, as Bun writes them. */
  async function sourceUnder(frames: readonly string[]): Promise<unknown> {
    const original = Error.prepareStackTrace;
    Error.prepareStackTrace = () => ['Error', ...frames.map((frame) => `    at ${frame}`)].join('\n');
    try {
      return (await collectModule(async () => void test('declared', noop), file)).tests[0]!.source;
    } finally {
      Error.prepareStackTrace = original;
    }
  }

  it('reads a top-level frame without a column', async () => {
    expect(await sourceUnder([`${file}:5`, 'unknown', 'processTicksAndRejections (native:7:39)'])).toEqual({ file, line: 5, column: 1 });
  });

  it("never takes Bun's builtin code for a file", async () => {
    expect(await sourceUnder(['processTicksAndRejections (native:7:39)'])).toBeUndefined();
  });
});

describe('old trace spellings on a test', () => {
  it('name the mode they meant', async () => {
    const register = (trace: unknown) =>
      collectModule(async () => {
        test('x', { trace } as never, noop);
      });
    await expect(register('retries')).rejects.toThrow("test options: trace 'retries' is the old spelling of trace: 'on-all-retries'");
    await expect(register({ record: 'retries' })).rejects.toThrow("trace { record: 'retries' } is the old spelling of trace: 'on-all-retries'");
    await expect(register('all')).rejects.toThrow("trace 'all' is the old spelling of trace: 'on'");
  });
});

describe('setup tests', () => {
  it('requires a static sessions list with valid names', async () => {
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: [] }, noop);
      }),
    ).rejects.toThrow(/at least one session/);
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: ['bad name!'] }, noop);
      }),
    ).rejects.toThrow(/invalid session name/);
  });

  it('must be top-level', async () => {
    await expect(
      collectModule(async () => {
        test.describe('group', () => {
          test.setup('auth', { sessions: ['a'] }, noop);
        });
      }),
    ).rejects.toThrow(/top-level/);
  });
});

describe('serial groups', () => {
  it('rejects nested serial groups', async () => {
    await expect(
      collectModule(async () => {
        test.describe('outer', { serial: true }, () => {
          test.describe('inner', { serial: true }, () => {
            test('x', noop);
          });
        });
      }),
    ).rejects.toThrow(/nested serial/);
  });

  it.each(['trace', 'video'] as const)('rejects a %s on a describe nested in a serial group, which records as one unit', async (kind) => {
    await expect(
      collectModule(async () => {
        test.describe('unit', { serial: true }, () => {
          test.describe('inner', { [kind]: 'off' }, () => {
            test('x', noop);
          });
        });
      }),
    ).rejects.toThrow(`describe option "${kind}" cannot be set inside a serial group`);
  });

  it('rejects member overrides of unit-owned options', async () => {
    for (const options of [{ retries: 1 }, { trace: 'on' }, { video: 'on' }, { session: 's' }, { skip: true }, { fail: true }, { only: true }]) {
      await expect(
        collectModule(async () => {
          test.describe('unit', { serial: true }, () => {
            test('member', options as never, noop);
          });
        }),
      ).rejects.toThrow(/serial group/);
    }
  });

  it('allows member tags, timeout, and agent context', async () => {
    const registration = await collectModule(async () => {
      test.describe('unit', { serial: true }, () => {
        test('member', { tags: ['a'], timeout: 5000, agentContext: 'ctx' }, noop);
      });
    });
    expect(registration.tests).toHaveLength(1);
  });
});

describe('test.extend', () => {
  const fixture = async ({}: object, use: (value: string) => Promise<void>) => {
    await use('value');
  };

  it('without definitions returns the same test object', () => {
    expect(test.extend<{ web: unknown }>()).toBe(test);
  });

  it('returns a new test whose registrations carry the accumulated chain in order', async () => {
    const first = test.extend<{ one: string }>({ one: fixture });
    const second = first.extend<{ two: string }>({ two: fixture });
    expect(first).not.toBe(test);
    expect(second).not.toBe(first);
    const registration = await collectModule(async () => {
      test('plain', noop);
      first('one', noop);
      second('two', noop);
      second.skip('skipped', noop);
      second.only('focused', noop);
      second.setup('auth', { sessions: ['member'] }, noop);
      second.beforeEach(noop);
      second.afterEach(noop);
      first.afterAll(noop);
    });
    const chains = registration.tests.map((item) => item.fixtures.map((definition) => definition.name));
    expect(chains).toEqual([[], ['one'], ['one', 'two'], ['one', 'two'], ['one', 'two'], ['one', 'two']]);
    expect(registration.tests[2]!.fixtures[1]!.fn).toBe(fixture);
    const hookChains = registration.hooks.map((hook) => [hook.kind, ...hook.fixtures.map((definition) => definition.name)]);
    expect(hookChains).toEqual([['beforeEach', 'one', 'two'], ['afterEach', 'one', 'two'], ['afterAll', 'one']]);
  });

  it('reads a scope from [fn, { scope }], and none from a plain function', async () => {
    const extended = test.extend<{ page: string; plain: string }, { database: string }>({
      plain: fixture,
      page: [fixture, { scope: 'test' }],
      database: [fixture, { scope: 'worker' }],
    });
    const registration = await collectModule(async () => {
      extended('scoped', noop);
    });
    const scopes = registration.tests[0]!.fixtures.map((definition) => [definition.name, definition.scope, definition.fn === fixture]);
    // A plain function declares no scope: it is a test fixture unless it extends a worker fixture.
    expect(scopes).toEqual([['plain', undefined, true], ['page', 'test', true], ['database', 'worker', true]]);
  });

  it('reads auto from the options, in either scope, and numbers each extend() call', async () => {
    const extended = test
      .extend<{ watch: string; plain: string }, { install: string }>({
        plain: fixture,
        watch: [fixture, { auto: true }],
        install: [fixture, { scope: 'worker', auto: true }],
      })
      .extend<{ later: string }>({ later: [fixture, { auto: false }] });
    const registration = await collectModule(async () => {
      extended('auto', noop);
    });
    expect(registration.tests[0]!.fixtures.map(({ name, scope, auto, layer }) => ({ name, scope, auto, layer }))).toEqual([
      // A plain function declares neither: it has the scope and the auto of the fixture it extends, if any.
      { name: 'plain', scope: undefined, auto: undefined, layer: 0 },
      { name: 'watch', scope: undefined, auto: true, layer: 0 },
      { name: 'install', scope: 'worker', auto: true, layer: 0 },
      { name: 'later', scope: undefined, auto: false, layer: 1 },
    ]);
    expect(registration.tests[0]!.fixtures[0]!.source?.file).toBe(fileURLToPath(import.meta.url));
    expect(() => test.extend({ watch: [fixture, { auto: 'yes' }] } as never)).toThrow(/fixture "watch" auto must be true or false, got "yes"/);
  });

  it('refuses a fixture function that does not destructure its first parameter', () => {
    const whole = async (fixtures: object, use: (value: string) => Promise<void>) => use(String(fixtures));
    const rest = async ({ ...all }: object, use: (value: string) => Promise<void>) => use(String(all));
    expect(() => test.extend({ workspace: whole } as never)).toThrow(
      expect.objectContaining({ code: 'COLLECTION_ERROR', message: expect.stringContaining('fixture "workspace" must destructure its first parameter') }),
    );
    expect(() => test.extend({ workspace: [rest, { scope: 'worker' }] } as never)).toThrow(/worker fixture "workspace" takes the rest property "\.\.\.all"/);
  });

  it('refuses a cycle and a worker fixture that names a test fixture, where they are declared', () => {
    const needs = (name: string) => new Function(`return async ({ ${name} }, use) => { await use(${name}); };`)() as typeof fixture;
    expect(() => test.extend({ a: needs('b'), b: needs('a') } as never)).toThrow(/fixtures depend on each other in a cycle: "a" -> "b" -> "a"/);
    // A fixture that names itself extends one of its name, which may be an engine's: decided per target.
    expect(() => test.extend({ a: needs('a') } as never)).not.toThrow();
    const withPage = test.extend<{ page: string }>({ page: [fixture, { scope: 'test' }] });
    expect(() => withPage.extend({ cache: [needs('page'), { scope: 'worker' }] } as never)).toThrow(/worker fixture "cache" names "page", a test fixture/);
    // A plain function is a test fixture, even if it extends an engine's worker fixture of its name.
    expect(() => test.extend({ page: fixture }).extend({ cache: [needs('page'), { scope: 'worker' }] } as never)).toThrow(/worker fixture "cache" names "page", a test fixture/);
    expect(() => test.extend({ cache: [needs('session'), { scope: 'worker' }] } as never)).toThrow(/worker fixture "cache" names "session", a test fixture/);
    // A name the chain lacks may be an engine's: left for the target to decide.
    expect(() => test.extend({ cache: [needs('device'), { scope: 'worker' }] } as never)).not.toThrow();
    // Siblings may name each other in any order.
    expect(() => test.extend({ member: needs('owner'), owner: fixture } as never)).not.toThrow();
  });

  it('rejects a malformed scoped definition', () => {
    expect(() => test.extend({ database: [fixture] } as never)).toThrow(/fixture "database" must be a function .* or \[fn, \{ scope/);
    expect(() => test.extend({ database: [fixture, { scope: 'file' }] } as never)).toThrow(/fixture "database" scope must be 'test' or 'worker', got "file"/);
    expect(() => test.extend({ database: [fixture, { scop: 'worker' }] } as never)).toThrow(/options has unknown key "scop"/);
  });

  it('carries the chain through skipIf, runIf, and fixme on an extended test', async () => {
    const extended = test.extend<{ one: string }>({ one: fixture });
    const registration = await collectModule(async () => {
      extended.skipIf(true)('skipped', noop);
      extended.runIf(true)('runs', noop);
      extended.fixme('fixme', noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.fixtures.map((definition) => definition.name)])).toEqual([
      ['skip', ['one']],
      ['normal', ['one']],
      ['fixme', ['one']],
    ]);
  });

  it('rejects anything but a plain object of functions', () => {
    for (const definitions of [null, [], 'workspace', new Map()]) {
      expect(() => test.extend(definitions as never)).toThrow(CollectionError);
      expect(() => test.extend(definitions as never)).toThrow(/plain object/);
    }
    expect(() => test.extend({ workspace: 'not a function' } as never)).toThrow(
      /fixture "workspace" must be a function/,
    );
    expect(() => test.extend({ '': fixture } as never)).toThrow(/must not be empty/);
  });

  it('takes a fixture named like a core fixture, or like an earlier one of the chain, as one that extends it', async () => {
    const needs = (name: string) => new Function(`return async ({ ${name} }, use) => { await use(${name}); };`)() as typeof fixture;
    const extended = test
      .extend({ app: needs('app'), platform: [needs('platform'), { scope: 'worker' }] } as never)
      .extend({ app: needs('app') } as never);
    const registration = await collectModule(async () => {
      extended('extends', noop);
    });
    expect(registration.tests[0]!.fixtures.map(({ name, layer }) => [name, layer])).toEqual([['app', 0], ['platform', 0], ['app', 1]]);
    // An override without a scope is a test fixture, so a worker fixture can't name it.
    expect(() => extended.extend({ seeded: [needs('app'), { scope: 'worker' }] } as never)).toThrow(/worker fixture "seeded" names "app", a test fixture/);
    // A worker-scoped override can't name a built-in that is a test fixture on every engine, itself included.
    expect(() => test.extend({ agent: [needs('agent'), { scope: 'worker' }] } as never)).toThrow(/worker fixture "agent" names "agent", a test fixture/);
    // A test-scoped override of a worker fixture is fine: a test fixture sees worker fixtures.
    expect(() => test.extend({ platform: [needs('platform'), { scope: 'test' }] } as never)).not.toThrow();
    const withWorkspace = test.extend({ workspace: [fixture, { scope: 'worker' }] } as never);
    expect(() => withWorkspace.extend({ workspace: [needs('workspace'), { scope: 'test' }] } as never)).not.toThrow();
  });
});

describe('collectFromRegistration', () => {
  it("derives each test's tags from its describe layers and its own, outermost first, each once", async () => {
    const registration = await collectModule(async () => {
      test.describe('outer', { tags: ['area', 'smoke'] }, () => {
        test.describe('inner', { tags: ['inner'] }, () => {
          test('leaf', { tags: ['smoke', 'leaf'] }, noop);
        });
        test('plain', noop);
      });
      test('untagged', noop);
    });
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    expect(collected.tests.map((item) => item.tags)).toEqual([['area', 'smoke', 'inner', 'leaf'], ['area', 'smoke'], []]);
  });

  it('derives stable IDs and detects duplicate title paths', async () => {
    const registration = await collectModule(async () => {
      test('one', noop);
      test.setup('auth', { sessions: ['member'] }, noop);
      test.describe('grp', () => {
        test('two', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    expect(collected.file).toBe('tests/a.e2e.ts');
    expect(collected.tests.map((item) => item.id)).toEqual([
      'tests/a.e2e.ts::one',
      'setup::tests/a.e2e.ts::auth',
      'tests/a.e2e.ts::grp::two',
    ]);

    const duplicate = await collectModule(async () => {
      test('same', noop);
      test('same', noop);
    });
    expect(() => collectFromRegistration('/root', '/root/tests/b.e2e.ts', duplicate)).toThrow(
      CollectionError,
    );
  });

  it('redacts registered secret values in test and describe titles before ids are derived, and detects a collision after', async () => {
    const value = 'sk_title_9f3Kq2';
    const redact = (title: string) => title.replaceAll(value, '<secret:probe>');
    const registration = await collectModule(async () => {
      test.describe(`suite ${value}`, { serial: true }, () => {
        test(`holds ${value}`, noop);
      });
    }, undefined, redact);
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    const [only] = collected.tests;
    expect(only!.title).toBe('holds <secret:probe>');
    expect(only!.titlePath).toEqual(['suite <secret:probe>', 'holds <secret:probe>']);
    expect(only!.group?.title).toBe('suite <secret:probe>');
    expect(only!.id).toBe('tests/a.e2e.ts::suite%20%3Csecret%3Aprobe%3E::holds%20%3Csecret%3Aprobe%3E');
    expect(only!.serialId).toBe('serial::tests/a.e2e.ts::suite%20%3Csecret%3Aprobe%3E');
    expect(JSON.stringify(collected.tests.map(({ fn: _fn, group: _group, serialRoot: _root, ...rest }) => rest))).not.toContain(value);

    const colliding = await collectModule(async () => {
      test(`token ${value}`, noop);
      test('token <secret:probe>', noop);
    }, undefined, redact);
    expect(() => collectFromRegistration('/root', '/root/tests/b.e2e.ts', colliding)).toThrow(
      'duplicate title path token <secret:probe> in tests/b.e2e.ts',
    );
  });

  it('redacts a title before normalizing it, so a value spelled in decomposed form still matches', async () => {
    const decomposed = 'café-Kq7Zr2';
    const registration = await collectModule(async () => {
      test.describe(`group ${decomposed}`, () => {
        test(`holds ${decomposed}`, noop);
      });
    }, undefined, (title) => title.replaceAll(decomposed, '<secret:probe>'));
    expect(registration.tests[0]!.titlePath).toEqual(['group <secret:probe>', 'holds <secret:probe>']);
  });

  it('checks the title limit again once a marker longer than the value replaces it', async () => {
    const value = 'Kq7Zr2';
    const title = `${'a'.repeat(512 - value.length)}${value}`;
    const redact = (text: string) => text.replaceAll(value, '<secret:probe>');
    await expect(collectModule(async () => test(title, noop), undefined, redact)).rejects.toThrow(
      'title must be 1 through 512 UTF-8 bytes after NFC, got 520 once secret values are redacted',
    );
    await expect(collectModule(async () => test.describe(title, () => undefined), undefined, redact)).rejects.toThrow(
      'once secret values are redacted',
    );
  });

  it('marks serial members with the unit source ID', async () => {
    const registration = await collectModule(async () => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/wizard.e2e.ts', registration);
    expect(collected.tests[0]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
    expect(collected.tests[1]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
  });

  it('rejects files outside the project root', async () => {
    const registration = await collectModule(async () => {
      test('x', noop);
    });
    expect(() => collectFromRegistration('/root/app', '/elsewhere/b.e2e.ts', registration)).toThrow(
      /outside the project root/,
    );
  });
});
