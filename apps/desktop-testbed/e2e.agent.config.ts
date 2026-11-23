import type { E2EConfig } from 'e2e';
import { gateway } from 'ai';
import base from './e2e.config.ts';

/**
 * The agentic suite against the same form. Run by hand, with a model:
 *
 *   AI_GATEWAY_API_KEY=... pnpm --filter @e2e-dev/desktop-testbed test:agent
 *
 * `E2E_MODEL` overrides the pinned model.
 */
export default {
  ...base,
  projectId: 'dev.e2e.desktop-testbed-agent',
  tests: 'tests-agent/**/*.e2e.ts',
  timeout: 300_000,
  agents: {
    default: {
      model: gateway(process.env.E2E_MODEL ?? 'openai/gpt-6-luna-fast'),
      judgmentTimeout: 90_000,
      context: 'This is a native macOS sign-in form, read through its accessibility tree.',
    },
  },
} satisfies E2EConfig;
