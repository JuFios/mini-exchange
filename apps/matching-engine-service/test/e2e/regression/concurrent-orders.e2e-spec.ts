import { engineApp } from '../engine-app';

const { list, register, request, submit } = engineApp();

it('keeps all fifty concurrent resting orders in the book', async () => {
  const owner = await register();
  const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(owner, { price: 100 + i })));
  expect(responses.every(({ status }) => status === 201 || status === 202)).toBe(true);
  const orders = await list(owner);
  expect(orders).toHaveLength(50);
  expect(orders.every(({ status }) => status === 'open')).toBe(true);
  const book = await (await request('/orders/book?instrument=ABC&depth=50')).json();
  expect(book.asks).toHaveLength(50);
  expect(book.asks.map((level: { orders: number }) => level.orders)).toEqual(Array(50).fill(1));
});

it('fills a resting lot at most once under concurrent buys', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  await Promise.all([submit(buyer, { side: 'buy' }), submit(buyer, { side: 'buy' })]);
  const buys = await list(buyer);
  const filled = buys.reduce((sum, order) => sum + Number(order.quantity) - Number(order.remainingQuantity), 0);
  expect(filled).toBe(1);
});

it('keeps cancellation and fills consistent with the committed book', async () => {
  const seller = await register();
  const buyer = await register();
  await submit(seller);
  const [sell] = await list(seller);
  const [cancel] = await Promise.all([
    request(`/orders/${sell.id}`, 'DELETE', seller),
    submit(buyer, { side: 'buy' }),
  ]);
  expect([200, 202, 409]).toContain(cancel.status);
  const [final] = await list(seller);
  const [buy] = await list(buyer);
  const book = await (await request('/orders/book?instrument=ABC')).json();
  if (buy.status === 'filled') {
    expect(final.status).toBe('filled');
    expect(book).toMatchObject({ bids: [], asks: [] });
  } else {
    expect(final.status).toBe('cancelled');
    expect(book.asks).toEqual([]);
    expect(book.bids).toMatchObject([{ quantity: '1.00000000' }]);
  }
});
