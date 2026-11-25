/**
 * The engine manifest: `defineEngine` validates an engine at config load,
 * synchronously and loudly, and computes its capability set. A misspelled
 * member, an undeclared dependency, or a hook where data belongs is
 * `INVALID_CONFIG`, never a silent demotion to a lower tier.
 */

import { engineBrand } from '../internal/brands.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { obj } from '../internal/objects.ts';
import { isSecret } from '../secrets.ts';
import { ENGINE_SPI_VERSION, KNOWN_LOCATOR_ACTION_KINDS, POINTER_ACTION_KINDS } from './contract.ts';
import type { Secret } from '../types.ts';
import type { Engine, EngineCapability, EngineFixtureContext, EngineHandle, EngineIsolation } from './index.ts';

/** Every key an engine may declare; anything else is rejected at config load. */
const KNOWN_KEYS = [
  'name',
  'version',
  'spiVersion',
  'platform',
  'workers',
  'observe',
  'readStyle',
  'viewportIntersection',
  'locate',
  'perform',
  'actions',
  'performAt',
  'pointerActions',
  'tapModifiers',
  'selectsDevice',
  'grantsAllPermissions',
  'launchArgumentValues',
  'fileApps',
  'keyboard',
  'fixtures',
  'isolation',
  'state',
  'artifacts',
  'validateApp',
  'secrets',
  'session',
  'prepare',
  'finish',
  'doctor',
  'init',
  'startAttempt',
  'settleAttempt',
  'endAttempt',
  'dispose',
] as const satisfies readonly (keyof Engine)[];

/** Hooks of the nested manifests, closed like the top level. */
const NESTED_HOOKS = {
  keyboard: ['type', 'press', 'dismiss'],
  state: ['capture', 'restore'],
  artifacts: ['screenshot', 'startVideo', 'stopVideo'],
  session: ['open', 'openLink', 'back', 'resize', 'switchTab', 'closeTab', 'restart', 'reset'],
} as const;

/**
 * Hooks the contract no longer has, which an engine published before their
 * removal still declares: accepted and never called, so updating `e2e` alone
 * keeps such an engine working inside its peer range.
 */
const RETIRED_HOOKS: Readonly<Partial<Record<keyof typeof NESTED_HOOKS, readonly string[]>>> = {
  artifacts: ['startTrace', 'stopTrace'],
};

const FUNCTION_MEMBERS = [
  'observe',
  'readStyle',
  'viewportIntersection',
  'locate',
  'perform',
  'performAt',
  'prepare',
  'finish',
  'doctor',
  'init',
  'startAttempt',
  'settleAttempt',
  'endAttempt',
  'dispose',
  'validateApp',
] as const;

/** Universal fixture names a contribution may never shadow. */
const RESERVED_FIXTURES = new Set(['agent', 'app', 'screen', 'platform', 'request', 'session']);

/**
 * The methods an `@e2e-dev/core` session holds beside its fixtures. A session
 * is one flat object, so a fixture may not take one of these names, now or
 * when a control is added.
 */
export const SESSION_CONTROLS = ['saveState', 'setDefaultTimeout', 'close'] as const;
const SESSION_CONTROL_SET: ReadonlySet<string> = new Set(SESSION_CONTROLS);

const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

function invalid(name: string, detail: string): ConfigurationError {
  return new ConfigurationError('INVALID_CONFIG', `engine "${name}": ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one nested hook manifest (`state`, `artifacts`, `session`): a
 * plain object whose keys are closed and whose members are functions. Returns
 * a copy with every function bound to the manifest, so class-based bodies work.
 */
function hookManifest<K extends keyof typeof NESTED_HOOKS>(
  name: string,
  key: K,
  value: unknown,
  required: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(name, `${key} must be an object`);
  const hooks: readonly string[] = NESTED_HOOKS[key];
  const retired: readonly string[] = RETIRED_HOOKS[key] ?? [];
  for (const member of Object.keys(value)) {
    if (!hooks.includes(member) && !retired.includes(member)) {
      throw invalid(name, `${key} has unknown key "${member}"; expected one of ${hooks.join(', ')}`);
    }
    if (retired.includes(member) && typeof value[member] !== 'function') throw invalid(name, `${key}.${member} must be a function`);
  }
  const bound: Record<string, unknown> = {};
  for (const member of hooks) {
    const fn = value[member];
    if (fn === undefined) {
      if (required.includes(member)) throw invalid(name, `${key}.${member} must be a function`);
      continue;
    }
    if (typeof fn !== 'function') throw invalid(name, `${key}.${member} must be a function`);
    bound[member] = fn.bind(value);
  }
  return bound;
}

/** Validates the `secrets` declaration: a list of `Secret` handles, each name once. */
function declaredSecrets(name: string, value: unknown): readonly Secret[] {
  if (!Array.isArray(value)) throw invalid(name, 'secrets must be an array of secrets.get() handles');
  const seen = new Set<string>();
  const declared: Secret[] = [];
  for (const secret of value as readonly unknown[]) {
    if (!isSecret(secret)) throw invalid(name, 'secrets lists a value that is not a secrets.get() handle');
    if (seen.has(secret.name)) continue;
    seen.add(secret.name);
    declared.push(secret);
  }
  return Object.freeze(declared);
}

/** Validates a declared kind list (`actions`, `pointerActions`): a non-empty list of known kinds, each once. */
function declaredKinds<Kind extends string>(
  name: string,
  member: string,
  value: unknown,
  known: readonly Kind[],
): readonly Kind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(name, `${member} must be a non-empty array of action kinds (${known.join(', ')})`);
  }
  const seen = new Set<string>();
  for (const kind of value) {
    if (typeof kind !== 'string' || !(known as readonly string[]).includes(kind)) {
      throw invalid(name, `${member} names unknown kind ${JSON.stringify(kind)}; expected one of ${known.join(', ')}`);
    }
    if (seen.has(kind)) throw invalid(name, `${member} lists "${kind}" twice`);
    seen.add(kind);
  }
  return Object.freeze([...(value as Kind[])]);
}

/** The fixtures every session holds whatever its engine: an engine's `Fixtures` may narrow them, and contributes no factory for them. */
type CoreFixtureName = 'screen' | 'app' | 'platform';

/**
 * The spec `defineEngine<Fixtures>` takes: with a fixture beside the core
 * ones, `fixtures` must hold a factory for each, returning that fixture. A
 * union of fixture sets distributes, so the spec must satisfy one member.
 */
type EngineSpec<Fixtures extends object> = Fixtures extends object
  ? [Exclude<keyof Fixtures, CoreFixtureName>] extends [never]
    ? Engine
    : Omit<Engine, 'fixtures'> & {
      readonly fixtures: {
        readonly [Name in Exclude<keyof Fixtures, CoreFixtureName>]: (context: EngineFixtureContext) => Fixtures[Name];
      };
    }
  : never;

/**
 * The spec fields a literal `Platform` or a `'worker'` `Isolation` needs,
 * since an omitted `platform` is `undefined` at runtime and an omitted
 * `isolation` is `'attempt'`.
 */
type DeclaredLiterals<Platform extends string, Isolation extends EngineIsolation> = (string extends Platform ? {} : { readonly platform: Platform }) &
  ([Isolation] extends ['worker'] ? { readonly isolation: 'worker' } : {});

/**
 * Validates an engine and computes its capability set.
 *
 * The handle is assembled member by member from the known keys, reading
 * through the prototype chain and binding every function to the spec, so a
 * class instance (own state fields included) is as valid a body as a literal.
 * `Fixtures` types what the engine's `fixtures` contribute; the compiler
 * requires a factory returning each one it names beside `screen`, `app`, and
 * `platform`, and nothing checks them at runtime.
 */
export function defineEngine<
  Fixtures extends object = {},
  Platform extends string = string,
  Isolation extends EngineIsolation = EngineIsolation,
>(declared: EngineSpec<Fixtures> & { readonly platform?: Platform; readonly isolation?: Isolation } & DeclaredLiterals<Platform, Isolation>): EngineHandle<Fixtures, Platform, Isolation> {
  const spec = declared as Engine;
  if (typeof spec !== 'object' || spec === null) {
    throw new ConfigurationError('INVALID_CONFIG', 'defineEngine requires an engine object');
  }
  if (typeof spec.name !== 'string' || spec.name.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', 'engine.name must be a non-empty string');
  }
  const name = spec.name;
  if (typeof spec.version !== 'string' || spec.version.trim() === '') {
    throw invalid(name, 'version must be a non-empty string; it is recorded in reports and keys saved sessions');
  }
  if (spec.spiVersion !== ENGINE_SPI_VERSION) {
    throw invalid(
      name,
      `declares spiVersion ${String(spec.spiVersion)}; this runner supports ${ENGINE_SPI_VERSION}`,
    );
  }
  if (spec.platform !== undefined && (typeof spec.platform !== 'string' || spec.platform.trim() === '')) {
    throw invalid(name, 'platform must be a non-empty string when declared');
  }
  // A literal's unknown key is a misspelling or a misplaced tool; a class
  // instance's own fields are its state, so only literals are checked.
  if (Object.getPrototypeOf(spec) === Object.prototype) {
    const known: readonly string[] = KNOWN_KEYS;
    for (const key of Object.keys(spec)) {
      if (!known.includes(key)) {
        throw invalid(name, `unknown key "${key}" - tools belong on the agent, not the engine`);
      }
    }
  }
  for (const member of FUNCTION_MEMBERS) {
    if (spec[member] !== undefined && typeof spec[member] !== 'function') {
      throw invalid(name, `${member} must be a function`);
    }
  }
  if (spec.workers !== undefined && (!Number.isSafeInteger(spec.workers) || spec.workers < 1)) {
    throw invalid(name, 'workers must be a positive safe integer: the most workers the engine serves per target');
  }

  const capabilities = new Set<EngineCapability>();
  if (spec.observe !== undefined) capabilities.add('observation');
  if (spec.readStyle !== undefined) {
    if (!capabilities.has('observation')) throw invalid(name, 'declares readStyle without observe: style targets are observation refs');
    capabilities.add('computed-style');
  }
  if (spec.perform !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares perform without observe: action targets are observation refs');
    }
    if (spec.actions === undefined) {
      throw invalid(name, 'declares perform without actions: list the action kinds the surface honors');
    }
    capabilities.add('actions');
  } else if (spec.actions !== undefined) {
    throw invalid(name, 'declares actions without perform');
  }
  if (spec.locate !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares locate without observe: located nodes share the observation id space');
    }
    capabilities.add('location');
  }
  if (spec.viewportIntersection !== undefined) {
    if (!capabilities.has('location')) {
      throw invalid(name, 'declares viewportIntersection without locate: it measures located nodes');
    }
    capabilities.add('viewport-intersection');
  }
  if (spec.performAt !== undefined) {
    if (!capabilities.has('observation')) {
      throw invalid(name, 'declares performAt without observe: a point is read off the observation pixels');
    }
    if (spec.pointerActions === undefined) {
      throw invalid(name, 'declares performAt without pointerActions: list the pointer action kinds the surface honors');
    }
    capabilities.add('pointer');
  } else if (spec.pointerActions !== undefined) {
    throw invalid(name, 'declares pointerActions without performAt');
  }
  if (spec.tapModifiers !== undefined) {
    if (typeof spec.tapModifiers !== 'boolean') throw invalid(name, 'tapModifiers must be a boolean');
    if (spec.tapModifiers && !capabilities.has('actions')) {
      throw invalid(name, 'declares tapModifiers without perform: modifiers ride the tap actions perform receives');
    }
  }
  if (spec.selectsDevice !== undefined) {
    if (typeof spec.selectsDevice !== 'boolean') throw invalid(name, 'selectsDevice must be a boolean');
    if (spec.selectsDevice && spec.prepare === undefined) throw invalid(name, 'declares selectsDevice without prepare: prepare binds the device --device names');
  }
  if (spec.grantsAllPermissions !== undefined && typeof spec.grantsAllPermissions !== 'boolean') {
    throw invalid(name, 'grantsAllPermissions must be a boolean');
  }
  if (spec.launchArgumentValues !== undefined && typeof spec.launchArgumentValues !== 'boolean') throw invalid(name, 'launchArgumentValues must be a boolean');
  if (spec.fileApps !== undefined && typeof spec.fileApps !== 'boolean') throw invalid(name, 'fileApps must be a boolean');
  if (spec.isolation !== undefined && spec.isolation !== 'attempt' && spec.isolation !== 'worker') {
    throw invalid(name, `isolation must be 'attempt' or 'worker', got ${JSON.stringify(spec.isolation)}`);
  }
  if (spec.keyboard !== undefined && !capabilities.has('observation')) {
    throw invalid(name, 'declares keyboard without observe: the focused field is read off the observation');
  }

  const handle: Record<string, unknown> = obj({
    name,
    version: spec.version,
    spiVersion: spec.spiVersion,
    platform: spec.platform,
    workers: spec.workers,
  });
  for (const member of FUNCTION_MEMBERS) {
    const fn = spec[member];
    if (fn !== undefined) handle[member] = fn.bind(spec);
  }
  if (spec.actions !== undefined) handle['actions'] = declaredKinds(name, 'actions', spec.actions, KNOWN_LOCATOR_ACTION_KINDS);
  if (spec.tapModifiers === true) handle['tapModifiers'] = true;
  if (spec.selectsDevice === true) handle['selectsDevice'] = true;
  if (spec.grantsAllPermissions === true) handle['grantsAllPermissions'] = true;
  if (spec.launchArgumentValues === true) handle['launchArgumentValues'] = true;
  if (spec.fileApps === true) handle['fileApps'] = true;
  if (spec.isolation === 'worker') handle['isolation'] = 'worker';
  if (spec.pointerActions !== undefined) {
    handle['pointerActions'] = declaredKinds(name, 'pointerActions', spec.pointerActions, POINTER_ACTION_KINDS);
  }
  if (spec.fixtures !== undefined) {
    if (!isRecord(spec.fixtures)) throw invalid(name, 'fixtures must be an object');
    for (const [fixture, factory] of Object.entries(spec.fixtures)) {
      if (!FIXTURE_NAME_PATTERN.test(fixture)) {
        throw invalid(name, `fixture name "${fixture}" must be a lower-camel identifier`);
      }
      if (RESERVED_FIXTURES.has(fixture)) {
        throw invalid(name, `fixture name "${fixture}" shadows a universal fixture`);
      }
      if (SESSION_CONTROL_SET.has(fixture)) {
        throw invalid(name, `fixture name "${fixture}" is a method of every @e2e-dev/core session (${SESSION_CONTROLS.join(', ')}); name the fixture something else`);
      }
      if (typeof factory !== 'function') {
        throw invalid(name, `fixtures.${fixture} must be a factory function`);
      }
      capabilities.add(fixture);
    }
    // Bound like every other member, so a class-based engine keeps `this`
    // in its fixture factories too.
    handle['fixtures'] = Object.freeze(
      Object.fromEntries(
        Object.entries(spec.fixtures).map(([fixture, factory]) => [
          fixture,
          (factory as (...args: unknown[]) => unknown).bind(spec),
        ]),
      ),
    );
  }
  if (spec.keyboard !== undefined) {
    handle['keyboard'] = hookManifest(name, 'keyboard', spec.keyboard, ['type', 'press']);
    capabilities.add('keyboard');
  }
  if (spec.state !== undefined) {
    handle['state'] = hookManifest(name, 'state', spec.state, ['capture', 'restore']);
    capabilities.add('state');
  }
  if (spec.artifacts !== undefined) {
    const artifacts = hookManifest(name, 'artifacts', spec.artifacts, ['screenshot']);
    if ((artifacts['startVideo'] === undefined) !== (artifacts['stopVideo'] === undefined)) {
      throw invalid(name, 'artifacts.startVideo and stopVideo must be declared together');
    }
    handle['artifacts'] = artifacts;
    capabilities.add('artifacts');
  }
  if (spec.secrets !== undefined) handle['secrets'] = declaredSecrets(name, spec.secrets);
  if (spec.session !== undefined) handle['session'] = hookManifest(name, 'session', spec.session);

  // oxlint-disable-next-line e2e/no-chained-type-assertions -- assembled key by key above, so the record is an Engine by construction
  return Object.freeze({
    ...handle,
    [engineBrand]: true as const,
    capabilities,
  }) as unknown as EngineHandle<Fixtures, Platform, Isolation>;
}

/** True for a defineEngine-branded handle, across realms. */
export function isEngineHandle(value: unknown): value is EngineHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[engineBrand] === true
  );
}
