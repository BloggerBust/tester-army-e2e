/** The fixtures a `desktop()` target contributes, as types only. */

import type { Desktop } from './desktop.ts';

/** What a session on a `desktop()` target holds beside `screen` and `app`: the `desktop` fixture. */
export interface DesktopFixtures {
  readonly desktop: Desktop;
}
