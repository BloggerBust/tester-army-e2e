import { ConfigurationError, TestError } from './errors.ts';
import { isPlainObject } from './options.ts';
import type { LaunchArgumentValue, LaunchArgumentValues, ResolvedLaunchArguments } from '../types.ts';

/** What an old-style plist string may hold unquoted. `NSUserDefaults` reads a bare value that starts with `-` as the next argument's name. */
const PLIST_UNQUOTED = /^[A-Za-z0-9_$/:.][A-Za-z0-9_$/:.-]*$/;

const LAUNCH_ARGUMENTS_SHAPE = 'an array of strings or an object of argument name to string, number, boolean, or array of strings';

/**
 * Launch arguments as declared: a list of strings, or a plain object of
 * argument name (non-empty, no leading dash, no whitespace or control
 * characters) to string, finite number below 2^53 in magnitude, boolean,
 * or list of strings, none holding a NUL character. An `undefined` value, read from the
 * environment, is the entry left out. `code` picks the error: a target's
 * config fails with `INVALID_CONFIG`, a test's own launch with
 * `INVALID_ARGUMENT`.
 */
export function checkLaunchArguments(label: string, declared: unknown, code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT' = 'INVALID_CONFIG'): ResolvedLaunchArguments | undefined {
  if (declared === undefined) return undefined;
  if (Array.isArray(declared)) {
    const index = declared.findIndex((argument) => typeof argument !== 'string');
    if (index !== -1) {
      fail(code, `${label} must be ${LAUNCH_ARGUMENTS_SHAPE}; item ${index} is ${describe(declared[index])}`);
    }
    const nul = declared.findIndex((argument: string) => argument.includes('\u0000'));
    if (nul !== -1) fail(code, `${label} item ${nul} holds a NUL character`);
    return declared as readonly string[];
  }

  if (!isPlainObject(declared)) {
    fail(code, `${label} must be ${LAUNCH_ARGUMENTS_SHAPE}, got ${describe(declared)}`);
  }
  const entries: [string, LaunchArgumentValue][] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (value === undefined) continue;
    if (name === '') fail(code, `${label} has an empty argument name`);
    if (/[\s\p{Cc}]/u.test(name)) {
      fail(code, `${label} argument name ${JSON.stringify(name)} must have no whitespace or control characters`);
    }
    if (name.startsWith('-')) {
      fail(code, `${label} argument name ${JSON.stringify(name)} starts with a dash; remove the dash, the engine adds it`);
    }
    if (Array.isArray(value)) {
      const index = value.findIndex((item) => typeof item !== 'string');
      if (index !== -1) fail(code, `${label}.${name} must be a string, number, boolean, or array of strings; item ${index} is ${describe(value[index])}`);
    } else if (!isLaunchArgumentScalar(value)) {
      fail(code, `${label}.${name} must be a string, number, boolean, or array of strings, got ${describe(value)}`);
    }
    if (holdsNul(value)) fail(code, `${label}.${name} holds a NUL character`);
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

export function engineLaunchArguments(launchArguments: ResolvedLaunchArguments | undefined): {
  readonly launchArguments?: readonly string[];
  readonly launchArgumentValues?: LaunchArgumentValues;
} {
  if (launchArguments === undefined) return {};
  return Array.isArray(launchArguments) ? { launchArguments } : { launchArgumentValues: launchArguments as LaunchArgumentValues };
}

/**
 * Launch arguments as Apple process arguments. A list stays as it is. An
 * object becomes `-name value` for each entry, as `NSUserDefaults` reads it:
 * `YES` or `NO` for a boolean, an old-style plist array for a list, and a
 * quoted plist string for a value the parser would otherwise misread, such
 * as `(draft)` or `-1`.
 */
export function appleUserDefaults(launchArguments: ResolvedLaunchArguments): readonly string[] {
  if (Array.isArray(launchArguments)) return launchArguments;
  return Object.entries(launchArguments).flatMap(([name, value]) => [`-${name}`, appleUserDefault(value)]);
}

function appleUserDefault(value: LaunchArgumentValue): string {
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (typeof value === 'number' || typeof value === 'string') return plistString(String(value));
  return `(${value.map(plistString).join(', ')})`;
}

/** An old-style plist string: bare when its characters allow and it does not open a `//` comment, else quoted with `\\` and `"` escaped. */
function plistString(item: string): string {
  return PLIST_UNQUOTED.test(item) && !item.startsWith('//') ? item : `"${item.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function isLaunchArgumentScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function holdsNul(value: LaunchArgumentValue): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  return Array.isArray(value) && value.some((item) => item.includes('\u0000'));
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') {
    const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return isPlainObject(value) ? 'an object' : typeof name === 'string' && name !== '' ? `a ${name}` : 'an object';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER) return 'a number beyond 2^53 - 1';
  }
  return `a ${typeof value}`;
}

function fail(code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT', message: string): never {
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
