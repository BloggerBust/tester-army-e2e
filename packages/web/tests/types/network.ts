/** Compile-time assertions for `browser.setNetwork`: the states it takes. */
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
void browser.setNetwork('offline');
void browser.setNetwork('online');

// @ts-expect-error throttling profiles are not states.
void browser.setNetwork('slow-3g');
// @ts-expect-error the state is a name, not a boolean.
void browser.setNetwork(false);
// @ts-expect-error the state is required.
void browser.setNetwork();
