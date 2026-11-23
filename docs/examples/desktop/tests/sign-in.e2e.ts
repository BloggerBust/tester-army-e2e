import { test } from '@e2e-dev/desktop';
import { credentials, expect } from 'e2e';

test('signs in', async ({ app, screen }) => {
  const ada = credentials.user('ada');
  await app.open();
  await screen.getByRole('textbox', 'Username').fill(ada.username);
  await screen.getByRole('textbox', 'Password').fill(ada.password);
  await screen.getByRole('combobox', 'Plan').selectOption('Team');
  await screen.getByRole('button', 'Sign in').tap();
  await expect(screen.getByTestId('status')).toContainText('Signed in as ada');
});
