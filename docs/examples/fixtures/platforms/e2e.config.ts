import type { E2EConfig } from 'e2e';
import { mobile } from '@e2e-dev/mobile';
import { web } from '@e2e-dev/web';

export default {
  targets: [
    { engine: web(), app: { url: 'http://localhost:3000' } },
    { engine: mobile({ platform: 'ios' }), app: { bundleId: 'com.example.app' } },
  ],
} as const satisfies E2EConfig;
