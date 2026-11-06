import { engineApp } from '../engine-app';

const { list, register, request, submit } = engineApp();

it('hides another owner’s order and leaves it unchanged', async () => {
  const alice = await register();
  const bob = await register();
  expect((await submit(alice)).status).toBe(201);
  const [order] = await list(alice);

  const response = await request(`/orders/${order.id}?instrument=XYZ`, 'DELETE', bob);
  expect({ status: response.status, alice: await list(alice), bob: await list(bob) }).toEqual({
    status: 404,
    alice: [order],
    bob: [],
  });
});

it('rejects cancellation of a filled order and preserves its state', async () => {
  const alice = await register();
  const bob = await register();
  expect((await submit(alice)).status).toBe(201);
  expect((await submit(bob, { side: 'buy' })).status).toBe(201);
  const [filled] = await list(bob);
  expect(filled.status).toBe('filled');

  const response = await request(`/orders/${filled.id}`, 'DELETE', bob);
  expect({ status: response.status, orders: await list(bob) }).toEqual({
    status: 409,
    orders: [filled],
  });
});

it('checks the legacy instrument hint and cancels using the stored instrument', async () => {
  const owner = await register();
  expect((await submit(owner)).status).toBe(201);
  const [order] = await list(owner);
  const path = `/orders/${order.id}`;

  const mismatch = await request(`${path}?instrument=XYZ`, 'DELETE', owner);
  expect({ status: mismatch.status, orders: await list(owner) }).toEqual({
    status: 400,
    orders: [order],
  });

  expect((await request(path, 'DELETE', owner)).status).toBe(200);
  expect(await list(owner)).toMatchObject([{ id: order.id, status: 'cancelled' }]);
  const book = await request('/orders/book?instrument=ABC', 'GET', owner);
  expect(book.status).toBe(200);
  expect(await book.json()).toMatchObject({ bids: [], asks: [] });
});
