/**
 * Adapted from microsoft/playwright tests/page/page-wait-for-request.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `browser.waitForRequest` takes a URL
 * pattern or a predicate, `page.waitForEvent('request', predicate)` becomes
 * `browser.waitForRequest(predicate)`, and the request's `url()` is its `url`.
 */

/*
 * Not ported:
 * - should respect default timeout: needs `page.setDefaultTimeout`; e2e reads
 *   `actionTimeout` from the config.
 * - The TimeoutError class and the error stack pointing at the call: e2e fails
 *   the step with a code instead.
 * - The URL Playwright cuts short in its log line: e2e prints the pattern whole.
 */

import vm from 'node:vm';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page wait for request', { platforms: ['web'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [request] = await Promise.all([
      browser.waitForRequest(`${PREFIX}/digits/2.png`),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }`),
    ]);
    expect(request.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should work with predicate', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [request] = await Promise.all([
      browser.waitForRequest((candidate) => candidate.url === `${PREFIX}/digits/2.png`),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }`),
    ]);
    expect(request.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should respect timeout', async ({ browser }) => {
    const error = await browser.waitForRequest(() => false, { timeout: 1 }).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toContain('waitForRequest');
    expect(error?.message).toMatch(/exceeded its timeout|timed out/);
  });

  test('should log the url', async ({ browser }) => {
    const pattern = 'long-long-long-long-long-long-long-long-long-long-long-long-long-long.css';
    const error = await browser.waitForRequest(pattern, { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error as Error).message).toContain(`"${pattern}"`);
  });

  test('should work with no timeout', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [request] = await Promise.all([
      browser.waitForRequest(`${PREFIX}/digits/2.png`, { timeout: 0 }),
      browser.evaluate(`() => setTimeout(() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }, 50) && null`),
    ]);
    expect(request.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should work with url match', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [request] = await Promise.all([
      browser.waitForRequest(/digits\/\d\.png/),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
      }`),
    ]);
    expect(request.url).toBe(`${PREFIX}/digits/1.png`);
  });

  test('should work with url match regular expression from a different context', async ({ browser }) => {
    const context = vm.createContext();
    const regexp = vm.runInContext('new RegExp(/digits\\/\\d\\.png/)', context) as RegExp;

    await browser.goto(EMPTY_PAGE);
    const [request] = await Promise.all([
      browser.waitForRequest(regexp),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
      }`),
    ]);
    expect(request.url).toBe(`${PREFIX}/digits/1.png`);
  });
});
