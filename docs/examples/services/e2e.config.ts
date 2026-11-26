import { defineConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { email } from './services/email.ts';

export default defineConfig({
  projectId: 'dev.example.signup',
  services: { email },
  targets: [
    {
      name: 'web',
      engine: web(),
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: 'node',
          args: ['app/server.mjs'],
          env: async ({ services }) => ({
            PORT: '{port}',
            EMAIL_API_URL: services.email.url,
          }),
        },
      },
    },
  ],
});
