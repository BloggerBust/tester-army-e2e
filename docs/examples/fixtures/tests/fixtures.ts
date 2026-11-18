import { test as base } from '@e2e-dev/web';
import { expect, unique } from 'e2e';

export const test = base.extend<{ project: string; task: string }>({
  /** A fresh project, created and deleted through the app. */
  project: async ({ app, agent, screen }, use) => {
    const name = `Launch plan ${Date.now()}`;
    await app.open('/projects');
    await agent.act('create a project named {name}', { params: { name: unique(name) } });
    await expect(screen.getByRole('heading', name)).toBeVisible();
    await use(name);
    await app.open('/projects');
    await agent.act('delete the project {name}', { params: { name: unique(name) } });
    await expect(screen.getByRole('link', name)).toBeHidden();
  },
  /** One task in that project. Deleting the project deletes it too. */
  task: async ({ project, agent, screen }, use) => {
    const title = 'Write the announcement';
    await agent.act('add a task {title} to the project {project}', { params: { title, project } });
    await expect(screen.getByRole('checkbox', title)).toBeVisible();
    await use(title);
  },
});
