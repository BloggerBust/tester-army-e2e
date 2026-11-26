import { defineConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { resend } from './services/resend.ts';

export default defineConfig({
  projectId: 'dev.example.signup',
  services: { resend },
  targets: [
    {
      name: 'web',
      engine: web(),
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: 'node',
          args: ['app/server.mjs'],
          env: ({ services }) => ({
            PORT: '{port}',
            RESEND_API_KEY: 're_test',
            RESEND_BASE_URL: services.resend.url,
          }),
        },
      },
    },
  ],
});
