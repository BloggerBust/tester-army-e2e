/**
 * `@e2e-dev/desktop` public surface: the `desktop()` engine factory, the
 * `desktop` fixture types, and `test`, `describe`, and the hooks typed with
 * that fixture. `expect`, `credentials`, and `secrets` still come from
 * `e2e`. Without `e2e` installed, `desktop()` still loads and `test` throws
 * when used.
 */

import type { DesktopFixtures } from './fixtures.ts';
import { runnerTest } from './runner-test.ts';

export * from './engine-entry.ts';
/** The engine factory as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { default } from './engine-entry.ts';

/**
 * `test` typed with this engine's contributed `desktop` fixture. The same
 * runtime `test` as `e2e`'s; only the fixture types differ.
 */
export const test = runnerTest().extend<DesktopFixtures>();

/** `describe` and the hooks, the same functions as `test.describe` and `test.beforeEach`, typed with the `desktop` fixture. */
export const { describe, beforeEach, afterEach, beforeAll, afterAll } = test;
