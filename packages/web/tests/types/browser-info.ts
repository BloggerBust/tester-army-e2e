/** Compile-time assertions for `browser.name` and `browser.version`. */
import type { Browser, BrowserName } from '../../src/index.ts';

declare const browser: Browser;
const name: BrowserName = browser.name;
const version: string = browser.version;
void name;
void version;
if (browser.name === 'firefox') void browser.version.split('.');

// @ts-expect-error a brand is not an engine name.
if (browser.name === 'chrome') void 0;
// @ts-expect-error the identity is read-only.
browser.name = 'webkit';
// @ts-expect-error the identity is read-only.
browser.version = '1.0';
// @ts-expect-error the version is a property, not a method.
void browser.version();
