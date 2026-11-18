import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('shows the greeting form', async ({ app, screen }) => {
  await app.open();

  // The first read after launch can take over 5 seconds on iOS; see the README.
  await expect(screen.getByText('say hello')).toBeVisible({ timeout: 10_000 });
  await expect(screen.getByTestId('name')).toBeVisible();
});

test('asks for a name when the field is empty', async ({ app, screen }) => {
  await app.open();

  await screen.getByTestId('greet').tap();

  await expect(screen.getByTestId('error')).toHaveText('enter a name first.');
});

test('greets the name you type', async ({ app, screen }) => {
  await app.open();

  await screen.getByTestId('name').fill('Ada');
  await screen.getByTestId('greet').tap();

  await expect(screen.getByTestId('greeting')).toHaveText('hello, Ada!');
});
