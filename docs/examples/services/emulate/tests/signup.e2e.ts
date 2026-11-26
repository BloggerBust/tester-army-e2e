import { randomUUID } from 'node:crypto';
import { expect } from 'e2e';
import { test } from './fixtures.ts';

test('signing up sends a welcome email through Resend', async ({ app, screen, services }) => {
  const address = `ada+${randomUUID()}@example.com`;

  await app.open('/');
  await screen.getByRole('textbox', { name: 'Email' }).fill(address);
  await screen.getByRole('button', { name: 'Sign up' }).click();
  await expect(screen.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  const response = await fetch(`${services.resend.url}/emails`);
  const { data } = await response.json();

  expect(data.filter((email: { to: string[] }) => email.to.includes(address))).toEqual([
    expect.objectContaining({ to: [address], subject: 'Welcome' }),
  ]);
});
