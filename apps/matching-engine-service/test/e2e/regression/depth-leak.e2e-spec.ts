import { engineApp } from '../engine-app';

const { register, request, submit } = engineApp();

it('aggregates remaining quantities at each price and hides order identities', async () => {
  const maker = await register();
  const taker = await register();
  expect((await submit(maker, { quantity: 2 })).status).toBe(201);
  expect((await submit(maker, { quantity: '0.00000001' })).status).toBe(201);
  expect((await submit(maker, { price: 101 })).status).toBe(201);
  expect((await submit(taker, { side: 'buy', quantity: '0.5' })).status).toBe(201);

  const response = await request('/orders/book?instrument=ABC', 'GET', taker);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    bids: [],
    asks: [
      { price: '100.00', quantity: '1.50000001', orders: 2 },
      { price: '101.00', quantity: '1.00000000', orders: 1 },
    ],
  });
  const publicResponse = await request('/orders/book?instrument=ABC');
  expect(publicResponse.status).toBe(200);
  const book = await publicResponse.json();
  expect(JSON.stringify(book)).not.toMatch(/"(id|ownerId|userId|buyerUserId|sellerUserId)"\s*:/);
});
