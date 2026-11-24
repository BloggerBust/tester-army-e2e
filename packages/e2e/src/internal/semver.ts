/**
 * The slice of semantic versioning the CLI needs to reason about releases:
 * parsing, ordering, and the ranges npm reads, in the peer ranges the
 * published packages carry and the specs a package.json declares.
 */

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const PART = String.raw`(\d+|[xX*])`;
const COMPARATOR = new RegExp(String.raw`^(\^|~>?|>=|<=|>|<|=)?v?${PART}(?:\.${PART}(?:\.${PART}(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?)?)?$`, 'u');
const HYPHEN = /^(\S+)\s+-\s+(\S+)$/u;
/** The operators npm lets a space follow: `>= 1.2.3` is one comparator. */
const SPACED_OPERATOR = /(\^|~>?|>=|<=|>|<|=)\s+/gu;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The dot-separated prerelease identifiers; empty for a release. */
  readonly prerelease: readonly string[];
}

/** A full `major.minor.patch[-pre][+build]` version, a leading `v` allowed, or undefined. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4]?.split('.') ?? [] };
}

/** The version as npm writes it, without a build suffix. */
export function formatVersion(version: Version): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? core : `${core}-${version.prerelease.join('.')}`;
}

/** Negative when `a` comes before `b`, positive after, 0 when they are the same release. */
export function compareVersions(a: Version, b: Version): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core !== 0) return core;
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const order = compareIdentifiers(left, right);
    if (order !== 0) return order;
  }
  return 0;
}

/** Numeric identifiers sort numerically and before alphanumeric ones, which sort by code point. */
function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/u;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Comparator {
  readonly operator: '>=' | '<=' | '>' | '<' | '=';
  readonly version: Version;
}

/** A version with the parts an x-range leaves open (`1.x`, `1`, `*`) undefined, each open part opening the ones after it. */
interface Partial {
  readonly major: number | undefined;
  readonly minor: number | undefined;
  readonly patch: number | undefined;
  readonly prerelease: readonly string[];
}

/**
 * Whether `version` satisfies `range`, read as `specAccepts` reads a spec. A
 * range outside that grammar is satisfied by nothing.
 */
export function satisfies(version: Version, range: string): boolean {
  return specAccepts(range, version) === true;
}

/**
 * Whether a package.json spec admits `version`, by npm's range grammar:
 * comparator sets joined by `||`, each a hyphen range (`1.2 - 2`) or a
 * space-separated list of versions, `>=`, `>`, `<=`, `<`, `=`, `^`, and `~`
 * comparators, any of them partial or with `x` or `*` parts (`^0.23`,
 * `1.x`, `<=1.2`, `*`). As in node-semver, a prerelease satisfies a set only
 * when one of its comparators names a prerelease of the same
 * `major.minor.patch`. Undefined for a spec that is no range: a dist-tag, a
 * workspace or file link, an alias, a URL.
 */
export function specAccepts(spec: string, version: Version): boolean | undefined {
  const sets = spec.split('||').map(parseComparatorSet);
  if (sets.includes(undefined)) return undefined;
  return sets.some((set) => set !== undefined && setSatisfies(version, set));
}

function parseComparatorSet(text: string): Comparator[] | undefined {
  const trimmed = text.trim();
  const hyphen = HYPHEN.exec(trimmed);
  if (hyphen !== null) {
    const from = parsePartial(hyphen[1]!);
    const to = parsePartial(hyphen[2]!);
    if (from === undefined || to === undefined || from.operator !== undefined || to.operator !== undefined) return undefined;
    return [...atLeast(from.partial), ...upTo(to.partial)];
  }
  const comparators: Comparator[] = [];
  for (const part of trimmed.replace(SPACED_OPERATOR, '$1').split(/\s+/u)) {
    if (part === '') continue;
    const parsed = parsePartial(part);
    if (parsed === undefined) return undefined;
    comparators.push(...expand(parsed.operator, parsed.partial));
  }
  return comparators;
}

function parsePartial(text: string): { operator: string | undefined; partial: Partial } | undefined {
  const match = COMPARATOR.exec(text);
  if (match === null) return undefined;
  const number = (part: string | undefined): number | undefined => (part === undefined || /^[xX*]$/u.test(part) ? undefined : Number(part));
  const major = number(match[2]);
  const minor = major === undefined ? undefined : number(match[3]);
  const patch = minor === undefined ? undefined : number(match[4]);
  return { operator: match[1], partial: { major, minor, patch, prerelease: patch === undefined ? [] : (match[5]?.split('.') ?? []) } };
}

function release(major: number, minor: number, patch: number, prerelease: readonly string[] = []): Version {
  return { major, minor, patch, prerelease };
}

/** `<major.minor.patch-0`: below every release and prerelease of that version, so a ceiling admits no prerelease of the next one. */
function below(major: number, minor: number, patch: number): Comparator {
  return { operator: '<', version: release(major, minor, patch, ['0']) };
}

const NOTHING: readonly Comparator[] = [below(0, 0, 0)];

/** The floor of a partial version: its open parts as zero. No comparator when every version is at least it. */
function atLeast({ major, minor, patch, prerelease }: Partial): readonly Comparator[] {
  return major === undefined ? [] : [{ operator: '>=', version: release(major, minor ?? 0, patch ?? 0, prerelease) }];
}

/** The ceiling that holds every version a partial one stands for: `1.2` ends below `1.3.0`. */
function upTo({ major, minor, patch, prerelease }: Partial): readonly Comparator[] {
  if (major === undefined) return [];
  if (minor === undefined) return [below(major + 1, 0, 0)];
  if (patch === undefined) return [below(major, minor + 1, 0)];
  return [{ operator: '<=', version: release(major, minor, patch, prerelease) }];
}

/** The plain comparators one comparator of a range stands for, as node-semver desugars it. */
function expand(operator: string | undefined, partial: Partial): readonly Comparator[] {
  const { major, minor, patch, prerelease } = partial;
  if (major === undefined) return operator === '>' || operator === '<' ? NOTHING : [];
  switch (operator) {
    case '^':
      // A caret holds the leftmost nonzero part, or the last part the spec writes when all of them are zero.
      if (major > 0 || minor === undefined) return [...atLeast(partial), below(major + 1, 0, 0)];
      if (minor > 0 || patch === undefined) return [...atLeast(partial), below(major, minor + 1, 0)];
      return [...atLeast(partial), below(major, minor, patch + 1)];
    case '~':
    case '~>':
      return [...atLeast(partial), minor === undefined ? below(major + 1, 0, 0) : below(major, minor + 1, 0)];
    case '>=':
      return atLeast(partial);
    case '>':
      if (minor === undefined) return atLeast({ ...partial, major: major + 1 });
      if (patch === undefined) return atLeast({ ...partial, minor: minor + 1 });
      return [{ operator, version: release(major, minor, patch, prerelease) }];
    case '<':
      return patch === undefined ? [below(major, minor ?? 0, 0)] : [{ operator, version: release(major, minor ?? 0, patch, prerelease) }];
    case '<=':
      return upTo(partial);
    default:
      return patch === undefined ? [...atLeast(partial), ...upTo(partial)] : [{ operator: '=', version: release(major, minor ?? 0, patch, prerelease) }];
  }
}

function setSatisfies(version: Version, set: readonly Comparator[]): boolean {
  const holds = set.every(({ operator, version: bound }) => {
    const order = compareVersions(version, bound);
    switch (operator) {
      case '>=':
        return order >= 0;
      case '>':
        return order > 0;
      case '<=':
        return order <= 0;
      case '<':
        return order < 0;
      case '=':
        return order === 0;
    }
  });
  if (!holds || version.prerelease.length === 0) return holds;
  return set.some(
    ({ version: bound }) =>
      bound.prerelease.length > 0 && bound.major === version.major && bound.minor === version.minor && bound.patch === version.patch,
  );
}
