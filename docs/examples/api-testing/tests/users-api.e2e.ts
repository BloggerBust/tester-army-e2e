import { test, expect } from 'e2e';
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });

test('GET /api/users returns the seeded users', async ({ app }) => {
  const response = await fetch(`${app.baseUrl}/api/users`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  const users = expect(await response.json()).toMatchSchema(z.array(User));
  expect(users).toHaveLength(3);
  expect(users.map((user) => user.name)).toEqual(['Ada', 'Grace', expect.any(String)]);
});
