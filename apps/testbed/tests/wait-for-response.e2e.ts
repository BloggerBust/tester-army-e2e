/**
 * Adapted from microsoft/playwright tests/page/page-wait-for-response.spec.ts at v1.64.1.
 * Copyright Microsoft Corporation. Licensed under the Apache License 2.0 (see ../app/playwright/LICENSE).
 * Rewritten against the e2e public API: `browser.waitForResponse` takes a URL
 * pattern or a predicate, `page.waitForEvent('response', predicate)` becomes
 * `browser.waitForResponse(predicate)`, and the response's `url()` and
 * `text()` are its `url` and `text()`.
 */

/*
 * Not ported:
 * - should respect default timeout: needs `page.setDefaultTimeout`; e2e reads
 *   `actionTimeout` from the config.
 * - The TimeoutError class and the error stack pointing at the call: e2e fails
 *   the step with a code instead.
 */

import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { PREFIX } from './helpers.ts';

const EMPTY_PAGE = `${PREFIX}/empty.html`;

test.describe('page wait for response', { platforms: ['web'], tags: ['playwright'] }, () => {
  test('should work', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response] = await Promise.all([
      browser.waitForResponse(`${PREFIX}/digits/2.png`),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should respect timeout', async ({ browser }) => {
    const error = await browser.waitForResponse(() => false, { timeout: 1 }).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toContain('waitForResponse');
    expect(error?.message).toMatch(/exceeded its timeout|timed out/);
  });

  test('should log the url', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const error1 = await browser.waitForResponse('foo.css', { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error1 as Error).message).toContain('"foo.css"');
    const error2 = await browser.waitForResponse(/foo.css/i, { timeout: 1000 }).catch((caught: Error) => caught);
    expect((error2 as Error).message).toContain('/foo.css/i');
  });

  test('should work with no timeout', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response] = await Promise.all([
      browser.waitForResponse(`${PREFIX}/digits/2.png`, { timeout: 0 }),
      browser.evaluate(`() => setTimeout(() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }, 50) && null`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should work with predicate', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response] = await Promise.all([
      browser.waitForResponse((candidate) => candidate.url === `${PREFIX}/digits/2.png`),
      browser.evaluate(`() => {
        void fetch('/digits/1.png');
        void fetch('/digits/2.png');
        void fetch('/digits/3.png');
      }`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/2.png`);
  });

  test('should work with async predicate', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    const [response1, response2] = await Promise.all([
      browser.waitForResponse(async (candidate) => {
        const text = await candidate.text();
        return text.includes('contents of the file');
      }),
      browser.waitForResponse(async (candidate) => {
        const text = await candidate.text();
        return text.includes('bar');
      }),
      browser.evaluate(`() => {
        void fetch('/simple.json').then(r => r.json());
        void fetch('/file-to-upload.txt').then(r => r.text());
      }`),
    ]);
    expect(response1.url).toBe(`${PREFIX}/file-to-upload.txt`);
    expect(response2.url).toBe(`${PREFIX}/simple.json`);
  });

  test('sync predicate should be only called once', async ({ browser }) => {
    await browser.goto(EMPTY_PAGE);
    let counter = 0;
    const [response] = await Promise.all([
      browser.waitForResponse((candidate) => {
        ++counter;
        return candidate.url === `${PREFIX}/digits/1.png`;
      }),
      browser.evaluate(`async () => {
        await fetch('/digits/1.png');
        await fetch('/digits/2.png');
        await fetch('/digits/3.png');
        return null;
      }`),
    ]);
    expect(response.url).toBe(`${PREFIX}/digits/1.png`);
    expect(counter).toBe(1);
  });
});
