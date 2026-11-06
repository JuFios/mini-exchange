import { engineApp } from './engine-app';

const { list, register, request, submit } = engineApp();

it('removes the stored order from the book when the UUID is sent in uppercase', async () => {
  const owner = await register();
  expect((await submit(owner)).status).toBe(201);
  const [order] = await list(owner);

  expect((await request(`/orders/${order.id.toUpperCase()}`, 'DELETE', owner)).status).toBe(200);
  expect(await list(owner)).toMatchObject([{ id: order.id, status: 'cancelled' }]);
  const book = await request('/instruments/ABC/book');
  expect(book.status).toBe(200);
  expect(await book.json()).toMatchObject({ bids: [], asks: [] });
});
