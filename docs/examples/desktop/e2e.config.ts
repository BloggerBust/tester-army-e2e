import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';

export default {
  targets: [
    {
      name: 'mac',
      engine: desktop(),
      app: { appPath: 'build/MyApp.app' },
    },
  ],
  credentials: {
    ada: { username: 'ada', password: process.env.ADA_PASSWORD ?? '' },
  },
} satisfies E2EConfig;
