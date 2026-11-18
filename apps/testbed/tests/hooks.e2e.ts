import { expect } from 'e2e';
import { onTodos, test, todosTest, unnamedSetupCount, type Account } from './worker-account.ts';

test.describe('hooks with a worker fixture', { tags: ['hooks'] }, () => {
  // Each test checks only what it can see itself, since a filter or a retry can run either one alone.
  const events: string[] = [];
  let fromBeforeAll: Account | undefined;

  test.beforeAll(({ account, platform }) => {
    events.push('beforeAll');
    expect(platform).toBe('web');
    fromBeforeAll = account;
  });

  test.beforeEach(async ({ app, screen, todo }) => {
    events.push('beforeEach');
    await app.open('/todos');
    await screen.getByLabel('New todo').fill(todo);
    await screen.getByLabel('New todo').press('Enter');
  });

  test.afterEach(async ({ screen, todo }) => {
    events.push('afterEach');
    await expect(screen.getByTestId('todo')).toContainText([todo]);
  });

  test.afterAll(({ account }) => {
    expect(fromBeforeAll).toBe(account);
    expect(events[0]).toBe('beforeAll');
    expect(events.at(-1)).toBe('afterEach');
  });

  test('gets the instance beforeAll got', async ({ account, screen }) => {
    expect(fromBeforeAll).toBe(account);
    expect(account.setups).toBe(1);
    await expect(screen.getByTestId('todo')).toContainText(['Todo for web-account']);
  });

  test('starts in a new browser context with the same account', async ({ account, screen }) => {
    expect(events[0]).toBe('beforeAll');
    expect(events.at(-1)).toBe('beforeEach');
    expect(fromBeforeAll).toBe(account);
    await expect(screen.getByTestId('todo')).toHaveCount(1);
  });
});

test.describe('hooks in a serial group', { serial: true, tags: ['hooks'] }, () => {
  let fromBeforeAll: Account | undefined;

  test.beforeAll(({ account }) => {
    fromBeforeAll = account;
  });

  test('step 1: adds a todo', async ({ app, screen, account }) => {
    // The group re-imports this file; the account comes from the worker, not a new setup.
    expect(fromBeforeAll).toBe(account);
    expect(account.setups).toBe(1);
    await app.open('/todos');
    await screen.getByLabel('New todo').fill('Serial todo');
    await screen.getByLabel('New todo').press('Enter');
  });

  test('step 2: sees it on the same page', async ({ screen }) => {
    await expect(screen.getByTestId('todo')).toContainText(['Serial todo']);
  });
});

todosTest.describe('fixtures on demand', { tags: ['hooks'] }, () => {
  todosTest('an auto fixture runs for a test that names nothing', async ({ screen }) => {
    await expect(screen.getByLabel('New todo')).toBeVisible();
  });

  todosTest('a fixture no test names is never set up', async ({ screen, account }) => {
    await screen.getByLabel('New todo').fill(`Todo for ${account.name}`);
    await screen.getByLabel('New todo').press('Enter');
    await expect(screen.getByTestId('todo')).toHaveCount(1);
    expect(unnamedSetupCount()).toBe(0);
  });
});

onTodos.describe('an extended built-in fixture', { tags: ['hooks'] }, () => {
  onTodos('runs for a test that names it', async ({ app, screen }) => {
    await expect(screen.getByLabel('New todo')).toBeVisible();
    expect(app.baseUrl).toBeDefined();
  });
});
