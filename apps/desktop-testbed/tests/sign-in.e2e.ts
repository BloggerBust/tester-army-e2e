import { test } from '@e2e-dev/desktop';
import { readFileSync } from 'node:fs';
import { Transformer } from '@napi-rs/image';
import { credentials, expect } from 'e2e';

test.describe('sign-in form', () => {
  test.beforeEach(async ({ app }) => {
    await app.open();
  });

  test('signs in with every control set', async ({ screen }) => {
    const ada = credentials.user('ada');
    await expect(screen.getByText('Not signed in')).toBeVisible();
    await screen.getByRole('textbox', 'Username').fill(ada.username);
    await screen.getByRole('textbox', 'Password').fill(ada.password);
    await screen.getByRole('checkbox', 'Remember me').check();
    await expect(screen.getByRole('checkbox', 'Remember me')).toBeChecked();
    await screen.getByRole('combobox', 'Plan').selectOption('Team');
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Team');
    await screen.getByRole('button', 'Sign in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Signed in as ada on Team, remembered (password: 7 characters)');
  });

  test('reads controls by test id and refuses an empty password', async ({ screen }) => {
    await screen.getByTestId('username').fill('grace');
    await expect(screen.getByTestId('username')).toHaveValue('grace');
    await screen.getByTestId('username').clear();
    await expect(screen.getByTestId('username')).toHaveValue('');
    await screen.getByTestId('sign-in').tap();
    await expect(screen.getByTestId('status')).toHaveText('Password is required');
  });

  test('starts every test from a fresh launch', async ({ screen, desktop }) => {
    expect(desktop.platform).toBe('macos');
    await expect(screen.getByTestId('username')).toHaveValue('');
    await expect(screen.getByRole('checkbox', 'Remember me')).not.toBeChecked();
    await expect(screen.getByRole('combobox', 'Plan')).toHaveValue('Pro');
    const windows = await desktop.windows();
    expect(windows.map((window) => window.title)).toEqual(['Sign In']);
  });

  test('takes a screenshot of the window with the password field painted over', async ({ app, screen }) => {
    const password = screen.getByRole('textbox', 'Password');
    await screen.getByRole('textbox', 'Username').fill('ada');
    await password.fill(credentials.user('ada').password);
    const field = await password.boundingBox();
    const beside = await screen.getByRole('textbox', 'Username').boundingBox();
    expect(field).not.toBeNull();
    expect(beside).not.toBeNull();
    const file = await app.screenshot('filled');
    // The window is 420 points wide: the capture's width over that is its scale.
    const image = decode(new Uint8Array(readFileSync(file)));
    const scale = image.width / 420;
    // The password field's own box is painted black, and the username field beside it keeps its pixels.
    expect(blackShare(image, field!, scale)).toBe(1);
    expect(blackShare(image, beside!, scale)).toBeLessThan(0.5);
  });
});

/** A decoded capture: its width and its RGBA pixels, rows top to bottom. */
interface Image {
  readonly width: number;
  readonly pixels: Uint8Array;
}

function decode(png: Uint8Array): Image {
  const transformer = new Transformer(png);
  return { width: transformer.metadataSync().width, pixels: transformer.rawPixelsSync() };
}

/** The share of opaque black pixels inside a box given in window points, a pixel in from each edge so rounding never reaches outside it. */
function blackShare(image: Image, box: { x: number; y: number; width: number; height: number }, scale: number): number {
  const left = Math.ceil(box.x * scale) + 1;
  const top = Math.ceil(box.y * scale) + 1;
  const right = Math.floor((box.x + box.width) * scale) - 1;
  const bottom = Math.floor((box.y + box.height) * scale) - 1;
  let black = 0;
  let total = 0;
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const at = (row * image.width + column) * 4;
      total += 1;
      if (image.pixels[at] === 0 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0 && image.pixels[at + 3] === 255) black += 1;
    }
  }
  return total === 0 ? 0 : black / total;
}
