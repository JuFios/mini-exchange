import { randomUUID } from 'node:crypto';
import { engineApp } from './engine-app';

const api = engineApp();
const token = () => process.env.INTERNAL_API_TOKEN!;
const lookup = (body: unknown, headers: Record<string, string> = {}) =>
  api.request('/internal/orders/terminal', 'POST', undefined, body, headers);
const authorized = () => ({ 'x-internal-token': token() });

async function place(user: string, changes: Record<string, unknown>): Promise<string> {
  const response = await api.submit(user, changes);
  expect(response.status).toBe(201);
  return (await response.json()).order.id;
}

it('rejects the lookup without a valid token of any length', async () => {
  const body = { orderIds: [] };
  expect((await lookup(body)).status).toBe(401);
  expect((await lookup(body, { 'x-internal-token': 'x'.repeat(token().length) })).status).toBe(401);
  expect((await lookup(body, { 'x-internal-token': 'x' })).status).toBe(401);
  expect((await lookup(body, authorized())).status).toBe(200);
});

it('returns only the filled and cancelled orders among the requested ones', async () => {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  const filled = await place(seller, { price: 100 });
  const filledBuy = await place(buyer, { side: 'buy', price: 100 });
  const cancelled = await place(seller, { price: 200 });
  expect((await api.request(`/orders/${cancelled}`, 'DELETE', seller)).status).toBe(200);
  const open = await place(seller, { price: 300 });
  const unknown = randomUUID();

  const response = await lookup(
    { orderIds: [filled, filledBuy, cancelled, open, unknown] },
    authorized(),
  );
  expect(response.status).toBe(200);
  const { orders } = await response.json();
  expect(orders.map(({ orderId }: { orderId: string }) => orderId).sort()).toEqual(
    [filled, filledBuy, cancelled].sort(),
  );
  expect(orders.find(({ orderId }: { orderId: string }) => orderId === cancelled)).toMatchObject({
    instrument: 'ABC',
    status: 'cancelled',
    closedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.+Z$/),
  });
  expect(orders.find(({ orderId }: { orderId: string }) => orderId === filled).status).toBe(
    'filled',
  );
  // Час переходу — момент останньої зміни заявки, а не її створення.
  const [{ moved }] = await api
    .database()
    .query('SELECT updated_at >= created_at AS moved FROM orders WHERE id = $1', [cancelled]);
  expect(moved).toBe(true);
});

it('answers an empty list with an empty result and rejects malformed bodies', async () => {
  expect(await (await lookup({ orderIds: [] }, authorized())).json()).toEqual({ orders: [] });
  const id = randomUUID();
  for (const body of [
    {},
    { orderIds: 'x' },
    { orderIds: ['not-a-uuid'] },
    { orderIds: [id, id] },
    { orderIds: Array.from({ length: 1001 }, () => randomUUID()) },
    { orderIds: [], extra: 1 },
  ])
    expect((await lookup(body, authorized())).status).toBe(400);
  const maximum = Array.from({ length: 1000 }, () => randomUUID());
  expect((await lookup({ orderIds: maximum }, authorized())).status).toBe(200);
});
