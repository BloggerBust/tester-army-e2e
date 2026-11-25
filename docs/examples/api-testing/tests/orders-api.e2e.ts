import { expect } from 'e2e';
import { test } from '@e2e-dev/web';

test('lists my orders', async ({ app, browser, request }) => {
  await app.open('/sign-in');
  // ...sign in through the UI...
  const cookies = await browser.cookies('/api/orders');
  const headers = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
  expect(await request.get('/api/orders', { headers })).toBeOK();
});
