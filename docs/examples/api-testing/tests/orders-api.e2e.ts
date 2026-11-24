import { expect } from 'e2e';
import { test } from '@e2e-dev/web';

test('lists my orders', async ({ app, browser, request }) => {
  await app.open('/sign-in');
  // ...sign in through the UI...
  // The domain your app sets the cookie on: its host, or `.example.com` for `Domain=example.com`.
  const domain = new URL(app.baseUrl).hostname;
  const session = (await browser.cookies()).find((c) => c.name === 'session' && c.domain === domain);
  if (session === undefined) throw new Error('not signed in');
  const headers = { cookie: `${session.name}=${session.value}` };
  expect((await request.get('/api/orders', { headers })).status).toBe(200);
});
