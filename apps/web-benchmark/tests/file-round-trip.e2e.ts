import { readFileSync } from 'node:fs';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

// The deterministic twin of the `file-round-trip` scenario: the voucher the
// page issues comes back verified, and a wrong file resets the input so the
// right one can still be chosen.
test.describe('file round trip', () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/e/file-round-trip');
  });

  test('downloads the issued voucher and verifies the same file uploaded back', async ({ screen, browser }) => {
    const download = await browser.waitForDownload(() => screen.getByTestId('download-button').tap());
    expect(download.suggestedFilename).toBe('voucher.txt');
    expect(readFileSync(download.absolutePath, 'utf8')).toBe('VOUCHER:WEB-5521');
    await expect(screen.getByTestId('download-status')).toHaveText('Voucher downloaded');

    await screen.getByTestId('upload-input').setInputFiles(download.absolutePath);
    await expect(screen.getByTestId('success-message')).toHaveText('Voucher verified');
  });

  test('rejects a file that is not the voucher, then accepts the issued one', async ({ screen, browser }) => {
    const download = await browser.waitForDownload(() => screen.getByTestId('download-button').tap());
    await screen.getByTestId('upload-input').setInputFiles('fixtures/not-the-voucher.txt');
    await expect(screen.getByTestId('error-message')).toHaveText('That is not the voucher we issued');
    await expect(screen.getByTestId('success-message')).toHaveCount(0);
    // The rejection resets the input, which is what lets the issued voucher be chosen next.
    await expect(screen.getByTestId('upload-input')).toHaveValue('');
    await screen.getByTestId('upload-input').setInputFiles(download.absolutePath);
    await expect(screen.getByTestId('success-message')).toHaveText('Voucher verified');
  });
});
