import { randomUUID } from 'node:crypto';
import { describe, test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { z } from 'zod';

const projectTest = test.extend<{ project: { id: string } }>({
  project: async ({ app, browser, request }, use) => {
    const cookies = await browser.cookies(`${app.baseUrl}/api/projects`);
    if (cookies.length === 0) throw new Error('not signed in: the app has no cookies');
    const headers = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') };
    let projectId: string | undefined;
    try {
      const created = await request.post(`${app.baseUrl}/api/projects`, { json: { name: `Project ${randomUUID()}` }, headers });
      const parsed = z.object({ id: z.string() }).safeParse(await created.json().catch(() => undefined));
      if (parsed.success && created.status >= 200 && created.status < 300) projectId = parsed.data.id;
      expect(created.status).toBe(201);
      if (!parsed.success) throw parsed.error;
      await use(parsed.data);
    } finally {
      if (projectId !== undefined) {
        const deleted = await request.delete(`${app.baseUrl}/api/projects/${projectId}`, { headers });
        expect([200, 204, 404]).toContain(deleted.status);
      }
    }
  },
});

describe('project settings', { session: 'admin' }, () => {
  projectTest('renames a project', async ({ agent, app, screen, project }) => {
    await app.open(`/projects/${project.id}/settings`); // straight to the screen under test

    await agent.act('Rename the project to {name} and save', { params: { name: 'Atlas' } });
    await screen.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor();
    await app.open(`/projects/${project.id}/settings`); // reopened: the promise is that it is saved

    await expect(screen.getByLabel('Name')).toHaveValue('Atlas');
  });
});
