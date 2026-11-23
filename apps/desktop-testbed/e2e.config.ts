import type { E2EConfig } from 'e2e';
import { desktop } from '@e2e-dev/desktop';

/**
 * The desktop testbed: a native AppKit sign-in form driven through
 * agent-desktop. Build the app once with `pnpm build:app`. macOS needs
 * Accessibility permission for the app that starts the run (Terminal, an
 * IDE, a CI agent), and Screen Recording for screenshots.
 *
 * `AGENT_DESKTOP_BINARY` points at an agent-desktop install of your own;
 * without it the engine downloads its pinned release on the first run.
 */
export const target = {
  name: 'macos',
  engine: desktop({ binary: process.env.AGENT_DESKTOP_BINARY }),
  app: { appPath: 'build/SignInForm.app' },
};

export default {
  projectId: 'dev.e2e.desktop-testbed',
  targets: [target],
  credentials: {
    ada: {
      username: 'ada',
      password: 'hunter2',
    },
  },
} satisfies E2EConfig;
