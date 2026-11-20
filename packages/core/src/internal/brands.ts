/** Internal brand symbols backing the opaque spec types. */

/**
 * A brand's key. At runtime it is the registered symbol, which every copy of
 * this package shares. Its type is the symbol's name, a string literal: a
 * `unique symbol` is unique to the declaration file that declares it, so two
 * installed copies of the package would disagree on every branded type, and
 * an engine handle or a locator built against one would not typecheck where
 * the other's is expected. A project gets two copies when it updates `e2e`
 * or an engine alone.
 */
function brand<const Name extends string>(name: Name): Name {
  const key: unknown = Symbol.for(name);
  // The one place the key's type parts from its value; see above.
  return key as Name;
}

export const secretBrand = brand('e2e.secret');
export const credentialBrand = brand('e2e.credential');
export const uniqueBrand = brand('e2e.unique');
export const testCaseBrand = brand('e2e.testCase');
export const engineBrand = brand('e2e.engine.v1');
/** Type-only slot naming the fixtures an engine contributes; no handle carries a value under it. */
export const engineFixtures = brand('e2e.engine.fixtures.v1');
export const locatorBrand = brand('e2e.locator');
/** Slot under which a fixture carries its attached expectation surface. */
export const expectationBrand = brand('e2e.expectation.v1');
/** Slot on `globalThis` naming the running attempt for `expect.poll`. */
export const attemptBrand: unique symbol = Symbol.for('e2e.attempt.v1');
/** Slot on `globalThis` naming the running `beforeAll` or `afterAll` hook for `test.setTimeout`. */
export const suiteHookBrand: unique symbol = Symbol.for('e2e.suiteHook.v1');
/** Slot on `globalThis` holding the runner's view of which phase owns an `expect.poll`. */
export const pollScopesBrand: unique symbol = Symbol.for('e2e.pollScopes.v1');
/** Slot on `globalThis` holding the secret values the sessions open in the process share. */
export const sharedSecretsBrand: unique symbol = Symbol.for('e2e.sharedSecrets.v1');
/** Slot on `globalThis` holding the rejections of steps already failed as not awaited. */
export const abandonedRejectionsBrand: unique symbol = Symbol.for('e2e.abandonedRejections.v1');
