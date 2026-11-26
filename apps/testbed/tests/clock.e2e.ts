import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test.describe('browser.clock', { platforms: ['web'], tags: ['browser'] }, () => {
  test('a paused clock moves only when the test runs it', async ({ app, screen, browser }) => {
    await browser.clock.install({ time: new Date('2024-02-02T08:00:00Z') });
    await browser.clock.pauseAt(new Date('2024-02-02T09:00:00Z'));
    await app.open('/clock');
    await expect(screen.getByLabel('Today')).toHaveText('February 2, 2024');
    await expect(screen.getByLabel('Offer')).toHaveText('Offer ends in 10s');
    await expect(screen.getByLabel('Progress')).toHaveText('0%');

    await browser.clock.runFor(3000);
    await expect(screen.getByLabel('Offer')).toHaveText('Offer ends in 7s');
    await expect(screen.getByLabel('Progress')).toHaveText('100%');

    await browser.clock.runFor('00:07');
    await expect(screen.getByLabel('Offer')).toHaveText('Offer expired');
    await expect(screen.getByRole('button', { name: 'Claim offer' })).toBeDisabled();
    await expect(screen.getByLabel('Session')).toHaveText('Signed in');

    await browser.clock.fastForward('30:00');
    await expect(screen.getByLabel('Session')).toHaveText('Session expired');
  });

  test('a fixed time holds the date while the page\'s timers keep running', async ({ app, screen, browser }) => {
    await browser.clock.setFixedTime('2030-12-31T23:59:59Z');
    await app.open('/clock');
    await expect(screen.getByLabel('Today')).toHaveText('December 31, 2030');
    // The countdown runs in real time here, so any second after the first will do.
    await expect(screen.getByLabel('Offer')).toHaveText(/^Offer ends in [1-9]s$/);
    await app.restart();
    await app.open('/clock');
    await expect(screen.getByLabel('Today')).toHaveText('December 31, 2030');
  });
});
