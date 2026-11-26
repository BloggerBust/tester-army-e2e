/**
 * Scenarios that need the engine's `device` fixture on top of locators: the
 * OS permission dialog, and a keyboard that covers the control to tap next.
 */

import { expect, openScenario, test } from './fixtures.ts';

test.describe('permission prompt', () => {
  test.beforeEach(async ({ app, device, screen }) => {
    await device.setPermission('microphone', 'reset');
    await openScenario({ app, device, screen }, 'Permission Prompt');
  });

  const ALERT_PLATFORMS = process.env.CI === 'true' ? { platforms: ['android'] } : {};
  // On the CI Mac (blacksmith-6vcpu-macos-26) the microphone alert makes the
  // iOS runner's main thread overrun its watchdog on `device.alert`, on every
  // run so far, and a wedged runner fails whatever follows; a Mac at a desk
  // passes. In CI both alert tests run on Android only until agent-device's
  // runner takes a system alert on that host.
  test('allowing the system dialog enables the microphone', ALERT_PLATFORMS, async ({ device, screen }) => {
    await screen.getByTestId('request-permission').tap();
    await device.alert('accept');
    await expect(screen.getByTestId('success-message')).toHaveText('Microphone enabled');
  });

  // Changing a permission terminates the app on iOS, so the grant made "in
  // settings" is picked up by a fresh visit rather than by Check again.
  test('a denied prompt recovers once the permission is granted outside', ALERT_PLATFORMS, async ({ app, device, screen }) => {
    await screen.getByTestId('request-permission').tap();
    await device.alert('dismiss');
    await expect(screen.getByTestId('denied-banner')).toBeVisible();
    await device.setPermission('microphone', 'grant');
    await device.openApp('dev.e2e.benchmark', { relaunch: true });
    await openScenario({ app, device, screen }, 'Permission Prompt');
    await screen.getByTestId('request-permission').tap();
    await expect(screen.getByTestId('success-message')).toHaveText('Microphone enabled');
  });
});

// `permissions: 'all'` grants the microphone before the launch, so the
// request resolves without a system dialog: a dialog left up would keep the
// scenario on its prompt and fail the check.
test('permissions all grants the microphone without a system dialog', async ({ app, device, screen }) => {
  await device.setPermission('microphone', 'reset');
  await device.openApp('dev.e2e.benchmark', { relaunch: true, permissions: 'all' });
  await openScenario({ app, device, screen }, 'Permission Prompt');
  await screen.getByTestId('request-permission').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Microphone enabled');
});

// Every step auto-focuses its field and keeps the keyboard up on Return
// (`submitBehavior="submit"`), so the keyboard covers Continue from the start
// and `device.dismissKeyboard()` is the way past it: Android hides the
// keyboard directly, iOS takes a short drag, which the wizard's scroll view
// turns into a dismissal. The success screen echoes the values, so a stray key
// press fails it.
test('sequential onboarding echoes the exact values', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sequential Onboarding');
  await screen.getByTestId('email-input').fill('jane@example.com');
  await device.dismissKeyboard();
  await screen.getByTestId('continue-button').tap();

  await screen.getByTestId('first-name-input').fill('Jane');
  await device.dismissKeyboard();
  await screen.getByTestId('last-name-input').fill('Merchant');
  await device.dismissKeyboard();
  await screen.getByTestId('continue-button').tap();

  await screen.getByTestId('phone-input').fill('0612435678');
  await device.dismissKeyboard();
  await screen.getByTestId('continue-button').tap();

  await expect(screen.getByTestId('success-message')).toHaveText('Onboarding complete');
  await expect(screen.getByTestId('echo-email')).toHaveText('jane@example.com');
  await expect(screen.getByTestId('echo-name')).toHaveText('Jane Merchant');
  await expect(screen.getByTestId('echo-phone')).toHaveText('0612435678');
});

// The Android emulator in CI draws no soft keyboard, even for a tapped field,
// so the keyboard reads run where one comes up. The email field autofocuses,
// and the keyboard slides in and out, so both reads poll.
test('isKeyboardShown follows the keyboard up and through a dismissal', { platforms: ['ios'] }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sequential Onboarding');
  await screen.getByTestId('email-input').fill('jane@example.com');
  await expect.poll(() => device.isKeyboardShown()).toBe(true);
  await device.dismissKeyboard();
  await expect.poll(() => device.isKeyboardShown()).toBe(false);
});

// The benchmark is a release build with no shake handler, so nothing on screen
// answers a shake. This checks only that the simulator and the emulator take
// the command without an error and that the screen reads afterwards; that a
// shake reaches an app is proven outside this suite, on an app that counts them.
test('a shake is sent without an error and leaves the screen readable', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sequential Onboarding');
  await device.shake();
  await expect(screen.getByTestId('email-input')).toBeVisible();
});

// lock and unlock each return only once the device reports the new state, so
// passing both is the round trip, and the screen read afterwards shows the app
// reads again. A lock that fails after it took effect still gets an unlock, so
// the tests after this one do not start locked; the test then fails with the
// lock's error, and the unlock's own error stays on its step. Android only:
// CI's iPhone 17 Pro simulator has an always-on display, where the unlock can
// leave the display off, and on its iOS 26.5 runtime every later fill on that
// simulator then fails its read-back.
test('a lock and an unlock both complete and leave the app readable', { platforms: ['android'] }, async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sequential Onboarding');
  try {
    await device.lock();
  } catch (error) {
    await device.unlock().catch(() => undefined);
    throw error;
  }
  await device.unlock();
  await expect(screen.getByTestId('email-input')).toBeVisible();
});

test('onboarding rejects a malformed email before advancing', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Sequential Onboarding');
  await screen.getByTestId('email-input').fill('jane');
  await device.dismissKeyboard();
  await screen.getByTestId('continue-button').tap();
  await expect(screen.getByTestId('step-error')).toHaveText('Enter a valid email address');
  await expect(screen.getByTestId('onboarding-step-email')).toBeVisible();
});

// The notes field's scroll view lets a tap through to its controls
// (`keyboardShouldPersistTaps="handled"`), and with the keyboard up the
// checkboxes and the switch sit across the middle of an iPhone screen. A
// dismissing drag that starts on one toggles it, the order goes invalid, and
// Place order stays disabled.
test('dismissing the keyboard over choice controls leaves them as they were', async ({ app, device, screen }) => {
  await openScenario({ app, device, screen }, 'Choice Controls');
  await screen.getByTestId('size-medium').tap();
  await screen.getByTestId('topping-cheese').tap();
  await screen.getByTestId('topping-olives').tap();
  await screen.getByTestId('rush-delivery').tap();
  await screen.getByTestId('delivery-notes').fill('Ring twice');
  await device.dismissKeyboard();
  await expect(screen.getByTestId('keyboard-warning')).toBeHidden();
  await screen.getByTestId('place-order').tap();
  await expect(screen.getByTestId('success-message')).toHaveText('Order placed: Medium with Cheese, Olives (rush)');
});
