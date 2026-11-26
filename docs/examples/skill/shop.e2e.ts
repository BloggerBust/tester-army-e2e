import { test, expect } from 'e2e';

test('filters the shop to items under $20', { session: 'customer' }, async ({ app, agent, screen }) => {
  const results = screen.getByRole('status', 'Results');
  const products = screen.getByRole('list', 'Products').getByRole('listitem');
  await app.open('/shop');
  await results.waitFor();
  await products.filter({ hasText: 'Leather Backpack, $90' }).waitFor();

  await agent.act('show only items under $20');

  await expect(results).toHaveText('2 items under $20');
  await expect(products).toHaveText(['Canvas Tote, $14', 'Steel Bottle, $18']);
});
