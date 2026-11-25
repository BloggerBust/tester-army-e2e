import { expect, test } from 'e2e';

test.describe.configure({ parallel: true });

for (const title of ['opens the todos', 'opens the todos again']) {
  test(title, { tags: ['parallel'] }, async ({ app, screen }) => {
    await app.open('/todos');
    await expect(screen.getByLabel('New todo')).toBeVisible();
  });
}

test.describe('in order', { parallel: false, tags: ['parallel'] }, () => {
  for (const todo of ['Run in order', 'Run after it']) {
    test(`adds "${todo}"`, async ({ app, screen }) => {
      await app.open('/todos');
      await screen.getByLabel('New todo').fill(todo);
      await screen.getByLabel('New todo').press('Enter');
      await expect(screen.getByTestId('todo')).toContainText([todo]);
    });
  }
});
