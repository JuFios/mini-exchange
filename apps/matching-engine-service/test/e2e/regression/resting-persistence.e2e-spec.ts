import { engineApp } from '../engine-app';

const { list, register, submit } = engineApp();

it('persists the remaining quantity and status of every matched resting order', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller, { quantity: 2 });
  await submit(buyer, { side: 'buy' });
  expect(await list(seller)).toMatchObject([{ status: 'partially_filled', remainingQuantity: '1.00000000' }]);
});
