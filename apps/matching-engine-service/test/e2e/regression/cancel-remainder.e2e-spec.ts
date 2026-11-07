import { engineApp } from '../engine-app';

const { list, register, request, submit } = engineApp();

it('preserves executed and unfilled quantities when cancelling a partially filled order', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  await submit(buyer, { side: 'buy', quantity: 2 });
  const [order] = await list(buyer);
  expect(order).toMatchObject({ status: 'partially_filled', remainingQuantity: '1.00000000' });
  expect((await request(`/orders/${order.id}`, 'DELETE', buyer)).status).toBe(200);
  expect(await list(buyer)).toMatchObject([
    {
      id: order.id,
      status: 'cancelled',
      quantity: '2.00000000',
      remainingQuantity: '1.00000000',
    },
  ]);
});
