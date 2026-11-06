import { engineApp } from '../engine-app';

const { list, register, request, submit } = engineApp();

it.each([
  ['a price over the limit', { price: 1e300 }],
  ['an empty instrument', { instrument: '' }],
  ['an unlisted instrument', { instrument: 'UNKNOWN' }],
  ['excess quantity precision', { quantity: '0.123456789' }],
  ['an extra field', { ownerId: 'another-user' }],
])('returns 400 for %s before creating an order', async (_description, body) => {
  const owner = await register();
  const response = await submit(owner, body);
  expect({ status: response.status, orders: await list(owner) }).toEqual({
    status: 400,
    orders: [],
  });
});

it.each([
  ['price', { price: 100.005 }, 'Некоректна ціна'],
  ['price', { price: '100.005' }, 'Некоректна ціна'],
  ['quantity', { quantity: 0.123456789 }, 'Некоректна кількість'],
  ['quantity', { quantity: '0.123456789' }, 'Некоректна кількість'],
])('reports the %s error in the same form for %j', async (_field, body, message) => {
  const owner = await register();
  const response = await submit(owner, body);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ message: [message] });
});

it('returns 400 for a malformed cancellation ID', async () => {
  const owner = await register();
  const response = await request('/orders/not-a-uuid', 'DELETE', owner);
  expect(response.status).toBe(400);
});
