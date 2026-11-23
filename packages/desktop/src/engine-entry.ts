/**
 * `@e2e-dev/desktop/engine`: the `desktop()` factory and its types, without
 * `test`, so a program that drives a desktop app with `@e2e-dev/core` never
 * loads the test runner. The main entry re-exports all of it beside `test`.
 */

export { desktop } from './engine.ts';
export type { DesktopEngine } from './engine.ts';
/** The engine factory again, as the default export: what `e2e mcp` calls when `open_session` names this package as its `engine`. */
export { desktop as default } from './engine.ts';
export type { DesktopOptions, DesktopPlatform } from './options.ts';
export type { Desktop } from './desktop.ts';
export type { DesktopWindow } from './surface.ts';
export type { DesktopFixtures } from './fixtures.ts';
