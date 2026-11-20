import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

// e2e reads CI the same way: unset, '', '0', and 'false' mean a local run.
const ci = !['', '0', 'false'].includes(process.env.CI?.trim().toLowerCase() ?? '');

export default {
  // Keep the `agents` entry that `init` wrote.
  targets: [{
    engine: web(),
    app: {
      url: 'http://localhost:3000',
      // CI serves the production build: run `next build` before `e2e run`.
      command: ci
        ? { executable: 'npm', args: ['run', 'start'] }
        : { executable: 'npm', args: ['run', 'dev'], reuseExisting: true },
    },
  }],
} satisfies E2EConfig;
