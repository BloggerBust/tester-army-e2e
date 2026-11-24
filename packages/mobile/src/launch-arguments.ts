import { ConfigurationError, TestError, appleUserDefaults, checkLaunchArguments, type LaunchArgumentValue, type ResolvedLaunchArguments } from '@e2e-dev/core/engine';
import type { MobilePlatform } from './options.ts';

type Code = 'INVALID_CONFIG' | 'INVALID_ARGUMENT';

/** The Apple user-defaults arguments a suite is likely to set; Android reads none of them. A name not listed here passes. */
const IOS_ONLY_ARGUMENTS: ReadonlySet<string> = new Set([
  'AppleLanguages',
  'AppleLocale',
  'AppleKeyboards',
  'AppleMeasurementUnits',
  'AppleMetricUnits',
  'AppleTemperatureUnit',
  'AppleFirstWeekday',
  'AppleTextDirection',
  'AppleICUForce24HourTime',
  'AppleICUForce12HourTime',
  'NSDoubleLocalizedStrings',
  'NSShowNonLocalizedStrings',
  'NSForceRightToLeftWritingDirection',
]);

export function launchArgumentsForOpen(platform: MobilePlatform, declared: unknown): ResolvedLaunchArguments | undefined {
  const label = 'device.openApp({ launchArguments })';
  const launchArguments = checkLaunchArguments(label, declared, 'INVALID_ARGUMENT');
  assertLaunchArgumentsFor(platform, label, launchArguments, 'INVALID_ARGUMENT');
  return launchArguments;
}

/**
 * Refuses an object Android cannot carry as declared: one of Apple's
 * arguments, or a list `am start` would read back changed. `--esa` splits
 * its value on every comma and keeps a backslash before one, so an item
 * holds no comma and ends in no backslash; an empty value arrives as one
 * empty item, so neither the list nor an item is empty.
 */
export function assertLaunchArgumentsFor(platform: MobilePlatform, label: string, launchArguments: ResolvedLaunchArguments | undefined, code: Code = 'INVALID_CONFIG'): void {
  if (platform !== 'android' || launchArguments === undefined || Array.isArray(launchArguments)) return;
  for (const [name, value] of Object.entries(launchArguments)) {
    if (IOS_ONLY_ARGUMENTS.has(name)) {
      fail(code, `${label}.${name} is an iOS launch argument, and Android reads none of Apple's; set the device's language before the run, or language and locale on a hosted device provider`);
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') continue;
    const problem = androidListProblem(value);
    if (problem !== undefined) fail(code, `${label}.${name} ${problem}: am start splits a list extra on commas`);
  }
}

function androidListProblem(items: readonly string[]): string | undefined {
  if (items.length === 0) return 'is an empty list, which Android reads as one empty item';
  for (const [index, item] of items.entries()) {
    if (item === '') return `item ${index} is empty`;
    if (item.includes(',')) return `item ${index} holds a comma`;
    if (item.endsWith('\\')) return `item ${index} ends in a backslash`;
  }
  return undefined;
}

export function launchArgumentList(platform: MobilePlatform, launchArguments: ResolvedLaunchArguments | undefined): readonly string[] | undefined {
  if (launchArguments === undefined) return undefined;
  const list = platform === 'android' ? androidArguments(launchArguments) : appleUserDefaults(launchArguments);
  return list.length === 0 ? undefined : list;
}

function androidArguments(launchArguments: ResolvedLaunchArguments): readonly string[] {
  if (Array.isArray(launchArguments)) return launchArguments;
  return Object.entries(launchArguments).flatMap(([name, value]) => androidExtra(name, value));
}

/** Java's `int` range; `am start` parses `--ei` with `Integer.parseInt`. */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * The extra of the value's type, so the app reads it with the matching
 * `Intent` getter: `--ez` boolean, `--ei` int, `--el` long, `--ef` float,
 * `--es` string, and `--esa` for a list, whose items `am` splits on commas.
 */
function androidExtra(name: string, value: LaunchArgumentValue): string[] {
  if (typeof value === 'boolean') return ['--ez', name, String(value)];
  if (typeof value === 'number') return [androidNumberFlag(value), name, String(value)];
  if (typeof value === 'string') return ['--es', name, value];
  return ['--esa', name, value.join(',')];
}

function androidNumberFlag(value: number): '--ei' | '--el' | '--ef' {
  if (!Number.isInteger(value)) return '--ef';
  return value >= INT32_MIN && value <= INT32_MAX ? '--ei' : '--el';
}

function fail(code: Code, message: string): never {
  throw code === 'INVALID_CONFIG' ? new ConfigurationError(code, message) : new TestError(code, message);
}
