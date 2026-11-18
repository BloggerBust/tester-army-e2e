/**
 * `@e2e-dev/mobile` public surface: the `mobile()` engine factory, the
 * `device` fixture types, and `test`, `describe`, and the hooks typed with
 * that fixture. `expect`, `credentials`, and `secrets` still come from
 * `e2e`; the agent-side tool pack lives on the `@e2e-dev/mobile/tools`
 * subpath so this entry never loads the AI SDK. Without `e2e` installed,
 * `mobile()` still loads and `test` throws when used.
 */

import type { TestFixtures } from 'e2e';
import type { MobileFixtures } from './fixtures.ts';
import { runnerTest } from './runner-test.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `device` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ. A device keeps
 * its state between attempts, so `device`, `app`, and `screen` are worker
 * fixtures, which `beforeAll` and `afterAll` receive too.
 */
export const test = runnerTest().extend<{}, MobileFixtures & Pick<TestFixtures, 'app' | 'screen'>>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `device` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
