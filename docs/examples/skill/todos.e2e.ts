// tests/todos.e2e.ts
import { test, expect } from 'e2e';

test.describe('todos', { tags: ['todos'] }, () => {
  test.beforeEach(async ({ app }) => {
    await app.open('/todos');
  });

  const labels = { list: 'Todos', remaining: 'Remaining' };
  const title = 'Write the release notes';
  const other = 'Book the venue';
  const addTodo = 'Add a todo named {title}';

  test('adds a todo to the list', async ({ agent, screen }) => {
    await agent.act(addTodo, { params: { title } });

    await expect(screen.getByRole('checkbox', title)).not.toBeChecked();
    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(1);
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('marks a todo as done', async ({ agent, screen }) => {
    const todo = screen.getByRole('checkbox', title);
    await agent.act(addTodo, { params: { title: other } });
    await agent.act(addTodo, { params: { title } });
    await todo.waitFor();

    // the second todo shown: this list adds new todos at the end
    await agent.act('Mark {title} as done', { params: { title } });

    await expect(todo).toBeChecked();
    await expect(screen.getByRole('checkbox', other)).not.toBeChecked();
    await expect(screen.getByRole('status', labels.remaining)).toHaveText('1 remaining');
  });

  test('ignores an empty submission', async ({ screen }) => {
    // An exact interaction: the empty submit is the point of the test.
    await screen.getByRole('button', 'Add').tap();

    await expect(screen.getByRole('list', labels.list).getByRole('listitem')).toHaveCount(0);
  });
});
