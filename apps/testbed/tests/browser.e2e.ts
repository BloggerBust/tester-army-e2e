import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('browser fixture', { platforms: ['web'], tags: ['browser'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/browser');
  });

  test('navigation verbs and the URL and title matchers', async ({ browser }) => {
    await expect(browser).toHaveTitle('Browser');

    await browser.goto('/about');
    await expect(browser).toHaveURL('/about');
    await expect(browser).toHaveTitle('About page');
    expect(await browser.url()).toMatch(/\/about$/);
    expect(await browser.title()).toBe('About page');

    await browser.back();
    await expect(browser).toHaveURL('/browser');
    await browser.forward();
    await expect(browser).toHaveURL(/about$/);
  });

  test('reload runs the page again', async ({ screen, browser }) => {
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 1');
    await browser.reload();
    await expect(screen.getByLabel('Loads')).toHaveText('loads: 2');
  });

  test('an init script runs before the page reads it, from the next load on', async ({ screen, browser }) => {
    await expect(screen.getByLabel('Random')).toHaveText('random: unseeded');
    await browser.addInitScript((value) => { Math.random = () => value; }, 0.5);
    await browser.reload();
    await expect(screen.getByLabel('Random')).toHaveText('random: seeded');
  });

  test('the viewport size is what the page measures', async ({ screen, browser }) => {
    await browser.setViewport({ width: 500, height: 700 });
    await expect(screen.getByLabel('Viewport')).toHaveText('500x700');
    await browser.setViewport({ width: 1024, height: 640 });
    await expect(screen.getByLabel('Viewport')).toHaveText('1024x640');
  });

  test('cookies set from the test reach the page and read back', async ({ screen, browser }) => {
    await expect(screen.getByLabel('Cookies')).toHaveText('no cookies');

    await browser.setCookies([{ name: 'theme', value: 'dark', url: await browser.url() }]);
    await browser.reload();
    await expect(screen.getByLabel('Cookies')).toContainText('theme=dark');
    const theme = (await browser.cookies()).find((cookie) => cookie.name === 'theme');
    expect(theme?.value).toBe('dark');
  });

  test('cookies(url) returns only the cookies a request to the URL carries', async ({ app, browser }) => {
    const { hostname } = new URL(app.baseUrl);
    await browser.setCookies([
      { name: 'everywhere', value: '1', url: app.baseUrl },
      { name: 'scoped', value: '1', domain: hostname, path: '/browser' },
      { name: 'elsewhere', value: '1', domain: 'other.example', path: '/' },
      { name: 'encrypted', value: '1', domain: 'shop.example', path: '/', secure: true },
      { name: 'shared', value: '1', domain: '.shop.example', path: '/' },
    ]);
    const names = async (urls?: string | string[]) => (await browser.cookies(urls)).map((cookie) => cookie.name).toSorted();

    expect(await names(app.baseUrl)).toEqual(['everywhere']);
    expect(await names('/browser')).toEqual(['everywhere', 'scoped']);
    expect(await names('/browsers')).toEqual(['everywhere']);
    expect(await names('http://shop.example/')).toEqual(['shared']);
    expect(await names('https://shop.example/')).toEqual(['encrypted', 'shared']);
    expect(await names('http://api.shop.example/')).toEqual(['shared']);
    expect(await names(['http://other.example/', '/browser'])).toEqual(['elsewhere', 'everywhere', 'scoped']);
    expect(await names()).toEqual(['elsewhere', 'encrypted', 'everywhere', 'scoped', 'shared']);
  });
});

test('the browser names its engine and reports a version before any page opens', { platforms: ['web'], tags: ['browser'] }, async ({ browser }) => {
  expect(['chromium', 'firefox', 'webkit']).toContain(browser.name);
  expect(browser.version).toMatch(/^\d+(\.\d+)*$/);
});

test('a test skips on the browsers it does not cover', { platforms: ['web'], tags: ['browser'] }, async ({ browser }) => {
  test.skip(browser.name !== 'chromium', 'covers Chromium only');
  expect(browser.name).toBe('chromium');
});

// A serial group's members share one session, each under an attempt id of its own.
test.describe('browser identity in a serial group', { serial: true, platforms: ['web'], tags: ['browser'] }, () => {
  let first = '';

  test('the first member reads the identity', ({ browser }) => {
    expect(['chromium', 'firefox', 'webkit']).toContain(browser.name);
    first = browser.version;
  });

  test('the second member reads the same browser', ({ browser }) => {
    expect(browser.version).toBe(first);
  });
});

test('offline fails the page\'s requests and navigations until the test goes back online', { platforms: ['web'], tags: ['browser'] }, async ({ app, screen, browser }) => {
  await app.open('/browser');
  await expect(screen.getByLabel('Network')).toHaveText('online');
  await browser.setNetwork('offline');
  await expect(screen.getByLabel('Network')).toHaveText('offline');
  await screen.getByRole('button', 'Ping').tap();
  await expect(screen.getByLabel('Ping')).toHaveText('no answer');
  const failure = await browser.reload().then(() => undefined, (error: unknown) => error);
  expect(failure).toMatchObject({ code: 'ACTION_FAILED' });
  await browser.setNetwork('online');
  await app.open('/browser');
  await expect(screen.getByLabel('Network')).toHaveText('online');
  await screen.getByRole('button', 'Ping').tap();
  await expect(screen.getByLabel('Ping')).toHaveText('answered');
});

test('emulated media reaches the page\'s own @media rules, from the first paint on', { platforms: ['web'], tags: ['browser'] }, async ({ app, screen, browser }) => {
  await browser.emulateMedia({ colorScheme: 'dark' });
  await app.open('/browser');
  await expect(screen.getByLabel('Media')).toHaveText('dark, full motion');
  await browser.emulateMedia({ reducedMotion: 'reduce' });
  await expect(screen.getByLabel('Media')).toHaveText('dark, reduced motion');
  await app.restart();
  await app.open('/browser');
  await expect(screen.getByLabel('Media')).toHaveText('dark, reduced motion');
  await browser.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await expect(screen.getByLabel('Media')).toHaveText('light, full motion');
});
