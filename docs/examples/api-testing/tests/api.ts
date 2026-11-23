import { test as base } from '@e2e-dev/web';

export const test = base.extend<{ api: (path: string, init?: RequestInit) => Promise<Response> }>({
  api: async ({ app, browser }, use) => {
    await use(async (path, init) => {
      const url = new URL(`${app.baseUrl}${path}`);
      if (url.origin !== new URL(app.baseUrl).origin) throw new Error(`${url} is not on the app`);
      const headers = new Headers(init?.headers);
      headers.set('cookie', (await browser.cookies()).map((c) => `${c.name}=${c.value}`).join('; '));
      return fetch(url, { ...init, headers });
    });
  },
});
