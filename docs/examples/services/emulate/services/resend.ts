import { createEmulator } from 'emulate';
import { defineService } from 'e2e';

export const resend = defineService({
  async *start() {
    const emulator = await createEmulator({ service: 'resend', port: 0 });

    yield { url: emulator.url };

    await emulator.close();
  },
});
