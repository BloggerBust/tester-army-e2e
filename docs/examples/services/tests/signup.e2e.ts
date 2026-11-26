import { expect } from 'e2e';
import { test } from './fixtures.ts';

test('signing up sends one welcome email', async ({ app, screen, services }) => {
  const inbox = await services.email.createInbox();

  await app.open('/');
  await screen.getByRole('textbox', { name: 'Email' }).fill(inbox.address);
  await screen.getByRole('button', { name: 'Sign up' }).click();

  const email = await services.email.waitForEmail(inbox.address, { subject: /welcome/i });

  expect(email.subject).toContain('Welcome');
  expect(await services.email.received(inbox.address)).toHaveLength(1);
});
