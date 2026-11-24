import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, parseVersion, satisfies, specAccepts } from '../../src/internal/semver.ts';

function version(text: string) {
  const parsed = parseVersion(text);
  if (parsed === undefined) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('parseVersion', () => {
  it.each(['0.21.2', 'v0.21.2', '0.21.3-nightly-20261019081103', '1.0.0-rc.1+build.5'])('reads %s', (text) => {
    expect(parseVersion(text)).toBeDefined();
  });

  it.each(['0.21', '^0.21.2', 'latest', '0.21.2.1', ''])('refuses %s', (text) => {
    expect(parseVersion(text)).toBeUndefined();
  });

  it('formats without the v or the build', () => {
    expect(formatVersion(version('v1.2.3-rc.1+abc'))).toBe('1.2.3-rc.1');
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.19.0', '0.20.0', -1],
    ['0.20.0', '0.20.0', 0],
    ['0.10.0', '0.9.9', 1],
    ['0.21.3-nightly-20261018072924', '0.21.3', -1],
    ['0.21.3-nightly-20261018072924', '0.21.3-nightly-20261019081103', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
  ] as const)('%s against %s is %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(version(a), version(b)))).toBe(sign);
  });
});

describe('satisfies', () => {
  it.each([
    ['0.21.2', '>=0.18.0 <1', true],
    ['0.17.9', '>=0.18.0 <1', false],
    ['1.0.0', '>=0.18.0 <1', false],
    ['0.21.2', '0.21.2', true],
    ['0.21.2', '=0.21.2', true],
    ['0.21.3', '0.21.2', false],
    ['0.21.3', '<0.20.0 || >=0.21.0', true],
    ['0.21.3', '>0.21.3', false],
    ['0.21.3', '<=0.21.3', true],
    // A prerelease satisfies only a set that names a prerelease of its own tuple.
    ['0.21.3-nightly-20261019081103', '>=0.15.0 <1', false],
    ['0.21.3-nightly-20261019081103', '0.21.3-nightly-20261019081103', true],
    ['0.21.3-nightly-20261019081103', '0.21.3-nightly-20261018072924', false],
    ['0.21.3-nightly-20261019081103', '>=0.21.3-nightly-20261018072924 <1', true],
    ['0.21.2', '^0.21.0', true],
    // No range: nothing satisfies it.
    ['0.21.2', 'latest', false],
    ['0.21.2', 'workspace:*', false],
  ] as const)('%s in %s is %s', (text, range, expected) => {
    expect(satisfies(version(text), range)).toBe(expected);
  });
});

// Each row agrees with node-semver's `satisfies`, the reading npm gives a package.json spec.
describe('specAccepts', () => {
  it.each([
    ['0.24.0', '0.23.0', false],
    ['0.23.0', '0.23.0', true],
    ['0.23.0', 'v0.23.0', true],
    ['0.23.0', '=0.23.0', true],
    ['0.23.0', '0.23.0+build.5', true],
    // Carets hold the leftmost nonzero part.
    ['0.23.0', '^0.23.0', true],
    ['0.23.4', '^0.23.0', true],
    ['0.24.0', '^0.23.0', false],
    ['0.22.9', '^0.23.0', false],
    ['1.2.3', '^1.2.3', true],
    ['1.2.2', '^1.2.3', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['0.23.4', '^ 0.23.0', true],
    // Partial carets hold the last part they write.
    ['0.23.9', '^0.23', true],
    ['0.24.0', '^0.23', false],
    ['0.22.9', '^0.23', false],
    ['0.24.0', '^0', true],
    ['1.0.0', '^0', false],
    ['0.0.9', '^0.0', true],
    ['0.1.0', '^0.0', false],
    ['1.9.9', '^1', true],
    ['2.0.0', '^1', false],
    ['1.9.9', '^1.x', true],
    ['1.1.9', '^1.2.x', false],
    // Tildes hold the minor, or the major when the spec stops there.
    ['0.23.1', '~0.23.1', true],
    ['0.23.0', '~0.23.1', false],
    ['0.23.9', '~0.23.1', true],
    ['0.24.0', '~0.23.1', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.0', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.9.0', '~1', true],
    ['2.0.0', '~1', false],
    ['1.2.9', '~>1.2.3', true],
    ['1.2.9', '~ 1.2.3', true],
    // X-ranges and partial versions.
    ['0.24.0', '*', true],
    ['0.24.0', '', true],
    ['0.24.0', 'x', true],
    ['0.23.5', '0.23', true],
    ['0.24.0', '0.23', false],
    ['0.23.5', '0.23.x', true],
    ['0.24.0', '0.23.*', false],
    ['0.24.0', '0.x', true],
    ['1.0.0', '0', false],
    ['0.24.0', '=0.24', true],
    // Comparators, partial and spaced.
    ['0.24.0', '>=0.23.0 <1', true],
    ['1.0.0', '>=0.23.0 <1', false],
    ['0.23.5', '>=0.23 <1', true],
    ['0.24.1', '<=0.24', true],
    ['0.25.0', '<=0.24', false],
    ['0.23.5', '>0.23', false],
    ['0.24.0', '>0.23', true],
    ['0.99.0', '>0', false],
    ['1.0.0', '>0', true],
    ['0.23.9', '<0.24', true],
    ['0.24.0', '<0.24', false],
    ['0.24.0', '>= 0.23.0', true],
    ['0.24.0', '>= 0.22.0 < 0.24.0', false],
    ['0.23.9', '>= 0.22.0 < 0.24.0', true],
    ['0.24.0', '>=v0.23.0', true],
    ['0.24.0', '>*', false],
    ['0.24.0', '>=*', true],
    // Alternatives.
    ['0.24.0', '^0.22.0 || ^0.23.0', false],
    ['0.23.1', '^0.22.0 || ^0.23.0', true],
    ['0.22.1', '^0.22.0||^0.23.0', true],
    ['0.24.0', '0.22 || >=0.24', true],
    // Hyphen ranges close on the right, over all of a partial version.
    ['0.23.0', '0.23.0 - 0.24.0', true],
    ['0.24.0', '0.23.0 - 0.24.0', true],
    ['0.24.1', '0.23.0 - 0.24.0', false],
    ['0.22.9', '0.23.0 - 0.24.0', false],
    ['0.24.9', '0.23 - 0.24', true],
    ['0.25.0', '0.23 - 0.24', false],
    ['1.9.9', '0.23 - 1', true],
    ['2.0.0', '0.23 - 1', false],
    // A prerelease needs a comparator naming a prerelease of its own version.
    ['0.24.1-nightly-20261019081103', '^0.24.1-nightly-20261018072924', true],
    ['0.24.2-nightly-20261019081103', '^0.24.1-nightly-20261018072924', false],
    ['0.24.2', '^0.24.1-nightly-20261018072924', true],
    ['0.24.1-nightly-20261019081103', '~0.24.1-nightly-20261018072924', true],
    ['0.24.1-nightly-20261017000000', '^0.24.1-nightly-20261018072924', false],
    ['0.24.1-nightly-20261019081103', '^0.24.0', false],
    ['0.24.1-nightly-20261019081103', '^0.24', false],
    ['0.24.1-nightly-20261019081103', '*', false],
    ['0.24.1-nightly-20261019081103', '0.24.1-nightly-20261019081103', true],
    ['0.24.1-nightly-20261019081103', '0.24.1-nightly-20261018072924 - 0.25.0', true],
    ['0.24.0-rc.1', '>=0.24.0-rc.0 <0.24', false],
    ['1.0.0-rc.1', '>=0.24.0 <1', false],
    ['0.24.0-rc.1', '<=0.24.0', false],
    ['0.24.0-rc.1', '<0.24.0', false],
    // No range to hold the version against.
    ['0.24.0', 'latest', undefined],
    ['0.24.0', 'next', undefined],
    ['0.24.0', 'workspace:*', undefined],
    ['0.24.0', 'workspace:^', undefined],
    ['0.24.0', 'catalog:', undefined],
    ['0.24.0', 'npm:e2e@0.23.0', undefined],
    ['0.24.0', 'file:../e2e', undefined],
    ['0.24.0', '../e2e', undefined],
    ['0.24.0', 'github:e2e-inc/e2e', undefined],
    ['0.24.0', 'e2e-inc/e2e#main', undefined],
    ['0.24.0', 'git+https://github.com/e2e-inc/e2e.git', undefined],
    ['0.24.0', 'https://e2e.com/e2e.tgz', undefined],
    ['0.24.0', '^0.23.0 || latest', undefined],
    ['0.24.0', '0.23.0 -', undefined],
    ['0.24.0', '^0.23.0 - 0.24.0', undefined],
    ['0.24.0', '>=', undefined],
  ] as const)('%s under "%s" is %s', (text, spec, expected) => {
    expect(specAccepts(spec, version(text))).toBe(expected);
  });
});
