import { describe, expect, it } from 'vitest';
import { launchArgumentList } from '../../src/launch-arguments.ts';

describe('launchArgumentList', () => {
  it('passes a list through as given and sends nothing for none', () => {
    expect(launchArgumentList({ launchArguments: ['-e2e', 'YES'] })).toEqual(['-e2e', 'YES']);
    expect(launchArgumentList({})).toEqual([]);
    expect(launchArgumentList({ launchArgumentValues: {} })).toEqual([]);
  });

  it('spells an object as user defaults the way NSUserDefaults reads them', () => {
    expect(launchArgumentList({ launchArgumentValues: { AppleLanguages: ['fr', 'en-GB'], AppleLocale: 'fr_FR', e2e: true, dark: false, retries: 3, offset: -1, mode: '(draft)', flag: '-x', quote: 'say "hi"\\' } })).toEqual([
      '-AppleLanguages', '(fr, en-GB)',
      '-AppleLocale', 'fr_FR',
      '-e2e', 'YES',
      '-dark', 'NO',
      '-retries', '3',
      '-offset', '"-1"',
      '-mode', '"(draft)"',
      '-flag', '"-x"',
      '-quote', '"say \\"hi\\"\\\\"',
    ]);
  });
});
