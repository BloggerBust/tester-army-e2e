import { describe, expect, it } from 'vitest';
import { collectFromRegistration } from '../../src/collect/collect.ts';
import { collectModule, test } from '../../src/collect/registry.ts';

const noop = async () => {};

/** Each test's placement among the parallel scopes of the file `declare` registers, by title. */
async function placements(declare: () => void): Promise<Record<string, { declared: boolean; ordered: string | undefined; suiteHooks: boolean }>> {
  const registration = await collectModule(async () => declare());
  const file = collectFromRegistration('/project', '/project/tests/a.e2e.ts', registration);
  return Object.fromEntries(file.tests.map((collected) => [collected.title, collected.parallel]));
}

describe('parallel scopes', () => {
  it('places a test in no parallel scope by default', async () => {
    expect(await placements(() => test('plain', noop))).toEqual({ plain: { declared: false, ordered: undefined, suiteHooks: false } });
  });

  it('declares the tests of a parallel group parallel, at any depth, and no test outside it', async () => {
    const placed = await placements(() => {
      test('outside', noop);
      test.describe('group', { parallel: true }, () => {
        test('inside', noop);
        test.describe('nested', () => test('deep', noop));
      });
    });
    expect(placed['outside']!.declared).toBe(false);
    expect(placed['inside']!.declared).toBe(true);
    expect(placed['deep']!.declared).toBe(true);
  });

  it('configures the whole file from the top level, wherever in the file the call is', async () => {
    const placed = await placements(() => {
      test('before', noop);
      test.describe.configure({ parallel: true });
      test('after', noop);
    });
    expect(placed['before']!.declared).toBe(true);
    expect(placed['after']!.declared).toBe(true);
  });

  it('configures the enclosing group from inside its body', async () => {
    const placed = await placements(() => {
      test('outside', noop);
      test.describe('group', () => {
        test.describe.configure({ parallel: true });
        test('inside', noop);
      });
    });
    expect(placed['outside']!.declared).toBe(false);
    expect(placed['inside']!.declared).toBe(true);
  });

  it('names the outermost scope that runs in order: a serial group, a parallel: false group, or the file', async () => {
    const placed = await placements(() => {
      test.describe.configure({ parallel: true });
      test('alone', noop);
      test.describe('serial', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
      test.describe('ordered', { parallel: false }, () => {
        test('first', noop);
        test.describe('steps', { serial: true }, () => test('second', noop));
      });
    });
    expect(placed['alone']!.ordered).toBeUndefined();
    expect(placed['step 1']!.ordered).toBeDefined();
    expect(placed['step 2']!.ordered).toBe(placed['step 1']!.ordered);
    expect(placed['first']!.ordered).not.toBe(placed['step 1']!.ordered);
    expect(placed['second']!.ordered).toBe(placed['first']!.ordered);

    const whole = await placements(() => {
      test.describe.configure({ parallel: false });
      test('one', noop);
      test.describe('group', () => test('two', noop));
    });
    expect(whole['one']!.ordered).toBe('file');
    expect(whole['two']!.ordered).toBe('file');
  });

  it('keeps two sibling groups that share a title apart, unless they are serial and so one serial group', async () => {
    const placed = await placements(() => {
      test.describe('same', { parallel: false }, () => test('one', noop));
      test.describe('same', { parallel: false }, () => test('two', noop));
      test.describe('steps', { serial: true }, () => test('first', noop));
      test.describe('steps', { serial: true }, () => test('second', noop));
      test.describe('other steps', { serial: true }, () => test('third', noop));
    });
    expect(placed['one']!.ordered).not.toBe(placed['two']!.ordered);
    expect(placed['first']!.ordered).toBe(placed['second']!.ordered);
    expect(placed['third']!.ordered).not.toBe(placed['first']!.ordered);
  });

  it('keeps one serial group id in one unit when parallel: false groups around it differ', async () => {
    const placed = await placements(() => {
      test.describe('outer', { parallel: false }, () => {
        test('one', noop);
        test.describe('steps', { serial: true }, () => test('first', noop));
      });
      test.describe('outer', { parallel: false }, () => {
        test('two', noop);
        test.describe('steps', { serial: true }, () => test('second', noop));
      });
      test.describe('apart', { parallel: false }, () => test('three', noop));
    });
    expect(new Set(['one', 'two', 'first', 'second'].map((title) => placed[title]!.ordered)).size).toBe(1);
    expect(placed['three']!.ordered).not.toBe(placed['one']!.ordered);
  });

  it('keeps a serial group id in the file\u2019s own unit when one of its groups is in no parallel scope', async () => {
    const placed = await placements(() => {
      test.describe('outer', () => test.describe('checkout', { serial: true }, () => test('first', noop)));
      test.describe('outer', { parallel: true }, () => {
        test.describe('checkout', { serial: true }, () => test('second', noop));
        test.describe('other', { serial: true }, () => test('third', noop));
      });
    });
    expect(placed['second']!.ordered).toBe(placed['first']!.ordered);
    expect(placed['first']!.declared).toBe(false);
    expect(placed['second']!.declared).toBe(false);
    expect(placed['third']!.declared).toBe(true);
  });

  it('marks the tests with a beforeAll or afterAll in a scope around them', async () => {
    const placed = await placements(() => {
      test('plain', noop);
      test.describe('hooked', () => {
        test.afterAll(noop);
        test('inside', noop);
        test.describe('nested', () => test('deep', noop));
      });
      test.describe('each', () => {
        test.beforeEach(noop);
        test('per test', noop);
      });
    });
    expect(placed['plain']!.suiteHooks).toBe(false);
    expect(placed['inside']!.suiteHooks).toBe(true);
    expect(placed['deep']!.suiteHooks).toBe(true);
    expect(placed['per test']!.suiteHooks).toBe(false);

    const file = await placements(() => {
      test.beforeAll(noop);
      test('any', noop);
    });
    expect(file['any']!.suiteHooks).toBe(true);
  });

  it.each([
    ['inside a serial group', () => test.describe('unit', { serial: true }, () => test.describe('inner', { parallel: true }, () => test('x', noop))), /inside a serial group/],
    ['inside a parallel: false group', () => test.describe('ordered', { parallel: false }, () => test.describe('inner', { parallel: true }, () => test('x', noop))), /inside a scope with parallel: false/],
    [
      'in a file with parallel: false',
      () => {
        test.describe.configure({ parallel: false });
        test.describe('inner', { parallel: true }, () => test('x', noop));
      },
      /inside a scope with parallel: false/,
    ],
    ['configured inside a serial group', () => test.describe('unit', { serial: true }, () => test.describe('inner', () => test.describe.configure({ parallel: true }))), /inside a serial group/],
  ])('rejects parallel: true %s', async (_, declare, message) => {
    await expect(collectModule(async () => declare())).rejects.toThrow(message);
  });

  it('rejects a parallel group inside an ordered scope whichever of the two is declared first', async () => {
    await expect(
      collectModule(async () => {
        test.describe('inner', { parallel: true }, () => test('x', noop));
        test.describe.configure({ parallel: false });
      }),
    ).rejects.toThrow('describe "inner": parallel: true cannot be set inside a scope with parallel: false');
    await expect(
      collectModule(async () =>
        test.describe('outer', () => {
          test.describe('inner', { parallel: true }, () => test('x', noop));
          test.describe.configure({ parallel: false });
        }),
      ),
    ).rejects.toThrow(/inside a scope with parallel: false/);
  });

  it('rejects parallel on a serial group, as an option or configured', async () => {
    await expect(collectModule(async () => test.describe('unit', { serial: true, parallel: true }, () => test('x', noop)))).rejects.toThrow(/cannot be set on a serial group/);
    await expect(collectModule(async () => test.describe('unit', { serial: true }, () => test.describe.configure({ parallel: false })))).rejects.toThrow(
      /cannot be set on a serial group/,
    );
  });

  it('rejects a describe.configure call once the file has registered', async () => {
    let late: (() => void) | undefined;
    await collectModule(async () => {
      late = () => test.describe.configure({ parallel: true });
    });
    expect(late).toThrow(/can only be called while a test module is being collected/);
  });

  it('rejects a second parallel for one scope', async () => {
    await expect(
      collectModule(async () => {
        test.describe.configure({ parallel: true });
        test.describe.configure({ parallel: false });
      }),
    ).rejects.toThrow('describe.configure(): parallel is already set for this scope');
    await expect(collectModule(async () => test.describe('group', { parallel: true }, () => test.describe.configure({ parallel: true })))).rejects.toThrow(
      /already set for this scope/,
    );
  });

  it('rejects a value that is not a boolean, an unknown key, and the mode other runners take', async () => {
    await expect(collectModule(async () => test.describe('group', { parallel: 'yes' as never }, () => test('x', noop)))).rejects.toThrow(
      'describe options: parallel must be true or false, got "yes"',
    );
    await expect(collectModule(async () => test.describe.configure({ retries: 2 } as never))).rejects.toThrow(/unknown key "retries"/);
    await expect(collectModule(async () => test.describe.configure(null as never))).rejects.toThrow(/takes an options object/);
    await expect(collectModule(async () => void test('x', { parallel: true } as never, noop))).rejects.toThrow(/test options has unknown key "parallel"/);
    await expect(collectModule(async () => test.describe.configure({ mode: 'parallel' } as never))).rejects.toThrow(/takes no mode: use \{ parallel: true \}/);
  });
});
