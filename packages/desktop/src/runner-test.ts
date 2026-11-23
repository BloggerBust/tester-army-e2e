/**
 * The test runner's `test`, which the main entry extends, loaded only when
 * `e2e` is installed. `e2e` is an optional peer: a program on
 * `@e2e-dev/core` alone imports `desktop` from this package too.
 */

import { createRequire } from 'node:module';
import { ConfigurationError } from '@e2e-dev/core/engine';
import type { test as RunnerTest } from 'e2e';

type Test = typeof RunnerTest;

const ownRequire = createRequire(import.meta.url);

/**
 * `e2e`'s `test`, or, when `e2e` is not installed, a stand-in whose every
 * call and member throws `RUNNER_NOT_INSTALLED`. Loaded with `require()`
 * rather than a top-level `await import()`, so this entry stays loadable by
 * `require()` from a CommonJS file.
 */
export function runnerTest(): Test {
  try {
    ownRequire.resolve('e2e');
  } catch (error) {
    // An installed `e2e` whose entry file is gone throws MODULE_NOT_FOUND too, naming that file: rethrown, not reported as not installed.
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && (error as Error).message.startsWith("Cannot find module 'e2e'")) return missingRunner();
    throw error;
  }
  return (ownRequire('e2e') as { test: Test }).test;
}

/**
 * A `test` whose every call, and every member's call, throws
 * `RUNNER_NOT_INSTALLED`, except `extend`, which returns it again so the
 * main entry can extend it while it loads.
 */
function missingRunner(): Test {
  const fail = (): never => {
    throw new ConfigurationError(
      'RUNNER_NOT_INSTALLED',
      "`test` from '@e2e-dev/desktop' needs e2e, the test runner, which is not installed. Install e2e to write tests, or import desktop() from '@e2e-dev/desktop/engine' to drive a desktop app with @e2e-dev/core.",
    );
  };
  // oxlint-disable-next-line e2e/no-chained-type-assertions -- the proxy answers every call and member of `test`, so it has its shape by construction
  const missing = new Proxy(fail, {
    get: (target, key) => {
      if (key === 'extend') return () => missing;
      return typeof key === 'string' && !Reflect.has(target, key) ? fail : Reflect.get(target, key);
    },
  }) as unknown as Test;
  return missing;
}
