import { randomUUID } from 'node:crypto';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { launch } from '@e2e-dev/core';
import { web } from '@e2e-dev/web/engine';

test('delivers a message to the recipient', { session: 'sender' }, async ({ app, screen }) => {
  const message = `Hello ${randomUUID()}`;
  await using host = await launch(web(), {
    app: { url: app.baseUrl },
    secrets: { RECIPIENT_PASSWORD: process.env.RECIPIENT_PASSWORD ?? '' },
  });
  const recipient = await host.newSession();
  await recipient.app.open('/login');
  await recipient.screen.getByLabel('Email').fill('recipient@example.test');
  await recipient.screen.getByLabel('Password').fill(host.secret('RECIPIENT_PASSWORD'));
  await recipient.screen.getByRole('button', 'Sign in').tap();
  await recipient.screen.getByRole('heading', 'Chat').waitFor();
  await app.open('/chat');

  await screen.getByLabel('Message').fill(message);
  await screen.getByRole('button', 'Send').tap();

  await expect(recipient.screen.getByText(message, { exact: true })).toBeVisible();
});
