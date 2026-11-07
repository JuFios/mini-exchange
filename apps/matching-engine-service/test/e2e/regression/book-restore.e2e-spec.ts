import { engineApp } from '../engine-app';

const { list, register, request, restart, submit } = engineApp();

it('restores resting orders after a restart and matches against them', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  await restart();
  const book = await (await request('/orders/book?instrument=ABC')).json();
  expect(book.asks).toMatchObject([{ price: '100.00', quantity: '1.00000000', orders: 1 }]);
  await submit(buyer, { side: 'buy' });
  expect(await list(buyer)).toMatchObject([{ status: 'filled', remainingQuantity: '0.00000000' }]);
});
