import { describe, expect, it } from 'vitest';
import { assertLaunchArgumentsFor, launchArgumentList, launchArgumentsForOpen } from '../../src/launch-arguments.ts';

describe('launchArgumentList', () => {
  it('passes a list through as given and sends nothing for none', () => {
    expect(launchArgumentList('ios', ['-e2e', 'YES'])).toEqual(['-e2e', 'YES']);
    expect(launchArgumentList('android', ['--ez', 'e2e', 'true'])).toEqual(['--ez', 'e2e', 'true']);
    expect(launchArgumentList('ios', undefined)).toBeUndefined();
    expect(launchArgumentList('ios', [])).toBeUndefined();
    expect(launchArgumentList('android', {})).toBeUndefined();
  });

  it('spells an object as iOS process arguments', () => {
    expect(launchArgumentList('ios', { AppleLocale: 'fr_FR', e2e: true, dark: false, retries: 3, ratio: 1.5, url: 'http://localhost:8081/x.json' })).toEqual([
      '-AppleLocale', 'fr_FR',
      '-e2e', 'YES',
      '-dark', 'NO',
      '-retries', '3',
      '-ratio', '1.5',
      '-url', 'http://localhost:8081/x.json',
    ]);
    expect(launchArgumentList('ios', { AppleLanguages: ['fr'] })).toEqual(['-AppleLanguages', '(fr)']);
    expect(launchArgumentList('ios', { AppleLanguages: ['fr', 'en-GB', 'zh-Hans'] })).toEqual(['-AppleLanguages', '(fr, en-GB, zh-Hans)']);
  });

  it('quotes a string NSUserDefaults would otherwise read as a plist, as a value and as a list item', () => {
    expect(launchArgumentList('ios', { title: '(draft)', greeting: 'a b', json: '{a=b;}', quoted: 'say "hi"' })).toEqual([
      '-title', '"(draft)"',
      '-greeting', '"a b"',
      '-json', '"{a=b;}"',
      '-quoted', '"say \\"hi\\""',
    ]);
    expect(launchArgumentList('ios', { names: ['a b', 'say "hi"', 'back\\slash', 'x,y', 'ok_1.2:3/4-5$'] })).toEqual([
      '-names',
      '("a b", "say \\"hi\\"", "back\\\\slash", "x,y", ok_1.2:3/4-5$)',
    ]);
    expect(launchArgumentList('ios', { empty: [] })).toEqual(['-empty', '()']);
    expect(launchArgumentList('ios', { tags: ['', 'a'], blank: '' })).toEqual(['-tags', '("", a)', '-blank', '""']);
  });

  it('quotes a string that starts with //, which the plist parser reads as a comment', () => {
    expect(launchArgumentList('ios', { endpoints: ['//cdn.example/assets', 'b'], cdn: '//cdn.example', path: 'a//b' })).toEqual([
      '-endpoints', '("//cdn.example/assets", b)',
      '-cdn', '"//cdn.example"',
      '-path', 'a//b',
    ]);
  });

  it('quotes a value that starts with a dash, which NSUserDefaults would read as the next name', () => {
    expect(launchArgumentList('ios', { offset: -1, ratio: -0.5, mode: '-x', range: 'a-b' })).toEqual([
      '-offset', '"-1"',
      '-ratio', '"-0.5"',
      '-mode', '"-x"',
      '-range', 'a-b',
    ]);
    expect(launchArgumentList('ios', { flags: ['-x', 'y'] })).toEqual(['-flags', '("-x", y)']);
  });

  it("spells an object as am start extras of each value's type", () => {
    expect(launchArgumentList('android', { e2e: true, dark: false, locale: 'fr_FR', retries: 3, ratio: 1.5, epoch: 2 ** 31, negative: -1, spaced: 'a b' })).toEqual([
      '--ez', 'e2e', 'true',
      '--ez', 'dark', 'false',
      '--es', 'locale', 'fr_FR',
      '--ei', 'retries', '3',
      '--ef', 'ratio', '1.5',
      '--el', 'epoch', '2147483648',
      '--ei', 'negative', '-1',
      '--es', 'spaced', 'a b',
    ]);
    expect(launchArgumentList('android', { max: 2147483647, min: -2147483648, below: -2147483649 })).toEqual([
      '--ei', 'max', '2147483647',
      '--ei', 'min', '-2147483648',
      '--el', 'below', '-2147483649',
    ]);
    expect(launchArgumentList('android', { tags: ['a', 'b c', 'd'] })).toEqual(['--esa', 'tags', 'a,b c,d']);
  });
});

describe('assertLaunchArgumentsFor', () => {
  const label = 'target "pixel" app.launchArguments';

  it("refuses Apple's arguments in an object on Android, and nothing else", () => {
    for (const name of ['AppleLanguages', 'AppleLocale', 'AppleKeyboards', 'AppleFirstWeekday', 'AppleTextDirection', 'NSDoubleLocalizedStrings']) {
      expect(() => assertLaunchArgumentsFor('android', label, { [name]: 'x' })).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining(`${label}.${name} is an iOS launch argument`) }),
      );
    }
    expect(() => assertLaunchArgumentsFor('android', 'label', { e2e: true, ApplePayEnabled: true })).not.toThrow();
    expect(() => assertLaunchArgumentsFor('android', 'label', ['-AppleLocale', 'fr_FR'])).not.toThrow();
    expect(() => assertLaunchArgumentsFor('android', 'label', undefined)).not.toThrow();
    expect(() => assertLaunchArgumentsFor('ios', 'label', { AppleLocale: 'fr_FR' })).not.toThrow();
  });

  it('refuses a list am start would read back changed on Android, and takes any list on iOS', () => {
    const cases: [readonly string[], string][] = [
      [[], `${label}.tags is an empty list, which Android reads as one empty item`],
      [['a', ''], `${label}.tags item 1 is empty`],
      [['a,b'], `${label}.tags item 0 holds a comma`],
      [['a\\', 'b'], `${label}.tags item 0 ends in a backslash`],
    ];
    for (const [tags, message] of cases) {
      expect(() => assertLaunchArgumentsFor('android', label, { tags })).toThrowError(
        expect.objectContaining({ code: 'INVALID_CONFIG', message: `${message}: am start splits a list extra on commas` }),
      );
      expect(() => assertLaunchArgumentsFor('ios', label, { tags })).not.toThrow();
    }
    expect(() => assertLaunchArgumentsFor('android', label, { tags: ['a', 'b c', 'back\\slash'] })).not.toThrow();
  });

  it('fails a launch a test asked for with INVALID_ARGUMENT', () => {
    expect(() => assertLaunchArgumentsFor('android', 'device.openApp({ launchArguments })', { AppleLocale: 'fr_FR' }, 'INVALID_ARGUMENT')).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

describe('launchArgumentsForOpen', () => {
  it('checks the declared shape and the platform rules, and leaves out an undefined value', () => {
    expect(launchArgumentsForOpen('ios', { reset: true, env: undefined })).toEqual({ reset: true });
    expect(launchArgumentsForOpen('ios', ['-reset'])).toEqual(['-reset']);
    expect(launchArgumentsForOpen('ios', undefined)).toBeUndefined();
    expect(() => launchArgumentsForOpen('ios', { env: null })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT', message: 'device.openApp({ launchArguments }).env must be a string, number, boolean, or array of strings, got null' }),
    );
    expect(() => launchArgumentsForOpen('ios', ['-a', 1])).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => launchArgumentsForOpen('android', { AppleLocale: 'fr_FR' })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => launchArgumentsForOpen('android', { tags: ['a,b'] })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
