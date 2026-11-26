import { test, expect } from 'e2e';

test.describe('test.step', { tags: ['step'] }, () => {
  test.beforeEach(async ({ app }) => {
    await test.step('Open the todos page', async () => {
      await app.open('/todos');
    });
  });

  test('names a group of calls and returns what its body returns', async ({ screen }) => {
    const count = await test.step('Add two todos', async () => {
      for (const title of ['Write spec', 'Ship runner']) {
        await test.step(`Add "${title}"`, async () => {
          await screen.getByLabel('New todo').fill(title);
          await screen.getByLabel('New todo').press('Enter');
        });
      }
      return screen.getByTestId('todo').count();
    });
    expect(count).toBe(2);

    await test.step('Check the counter', async () => {
      await expect(screen.getByRole('status', 'Remaining')).toHaveText('2 remaining');
    });
  });

  test('passes the error of a failed call on to the test', async ({ screen }) => {
    const failure = await test
      .step('Tap a button that is not there', async () => {
        await screen.getByRole('button', 'Missing').tap({ timeout: 200 });
      })
      .catch((error: unknown) => error);
    expect(failure instanceof Error).toBe(true);
    await expect(screen.getByTestId('todo')).toHaveCount(0);
  });
});
