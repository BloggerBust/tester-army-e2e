/** Compile-time assertions for `browser.clock`: Playwright's arguments, a time as a number, string, or Date and ticks as a number or string. */
import type { Browser } from '../../src/index.ts';

declare const browser: Browser;
void browser.clock.install();
void browser.clock.install({ time: new Date('2024-02-02T08:00:00') });
void browser.clock.install({ time: '2024-02-02T08:00:00' });
void browser.clock.pauseAt(Date.now());
void browser.clock.runFor('01:30');
void browser.clock.fastForward(1000);
void browser.clock.setFixedTime(new Date());
void browser.clock.setSystemTime('2024-02-02');
void browser.clock.resume();

// @ts-expect-error install takes an options object, not the time itself.
void browser.clock.install(Date.now());
// @ts-expect-error ticks are a number or a string, not a Date.
void browser.clock.runFor(new Date());
// @ts-expect-error pauseAt needs the time to pause at.
void browser.clock.pauseAt();
// @ts-expect-error there is no uninstall: the clock ends with the attempt.
void browser.clock.uninstall();
