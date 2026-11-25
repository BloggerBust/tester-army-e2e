import { test as base } from 'e2e';
import type config from '../e2e.config.ts';

export const test = base.extend<{ signedOut: void }, {}, typeof config>({
  /** Signs the app out. On iOS, the keychain is cleared first, since `app.clearState()` doesn't clear it. */
  signedOut: async ({ app, platform, device }, use) => {
    if (platform === 'ios') {
      await device.clearKeychain();
    }

    await app.clearState();
    await use();
  },
});
