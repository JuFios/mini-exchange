import { randomUUID } from 'node:crypto';
import { engineApp } from './engine-app';

const api = engineApp();
const token = () => process.env.RECONCILIATION_TOKEN!;
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

describe('live reserved orders', () => {
  const NIL = '00000000-0000-0000-0000-000000000000';
  const live = (body: unknown, headers: Record<string, string> = authorized()) =>
    api.request('/internal/orders/live', 'POST', undefined, body, headers);

  it('pages the resting orders accepted with a reservation in id order', async () => {
    const [seller, buyer] = await Promise.all([api.register(), api.register()]);
    const reserved = [
      await place(seller, { price: 400, quantity: 2 }),
      await place(seller, { price: 401 }),
      await place(seller, { price: 402 }),
    ];
    const plain = await place(seller, { price: 403 });
    const cancelled = await place(seller, { price: 404 });
    const filled = await place(seller, { price: 100 });
    await place(buyer, { side: 'buy', price: 100 });
    // Частково виконана лишається в книзі.
    await place(buyer, { side: 'buy', price: 400 });
    expect((await api.request(`/orders/${cancelled}`, 'DELETE', seller)).status).toBe(200);
    expect(
      await api
        .database()
        .query('SELECT status FROM orders WHERE id = ANY($1::uuid[]) ORDER BY price', [
          [reserved[0], filled],
        ]),
    ).toEqual([{ status: 'filled' }, { status: 'partially_filled' }]);
    await api
      .database()
      .query('UPDATE order_requests SET reserved = true WHERE order_id = ANY($1::uuid[])', [
        [...reserved, cancelled, filled],
      ]);

    const ids = async (body: Record<string, unknown>) => {
      const response = await live(body);
      expect(response.status).toBe(200);
      const { orders } = await response.json();
      return orders.filter(({ orderId }: { orderId: string }) =>
        [...reserved, plain, cancelled, filled].includes(orderId),
      );
    };
    const all = await ids({ after: NIL });
    expect(all.map(({ orderId }: { orderId: string }) => orderId)).toEqual([...reserved].sort());
    expect(all[0]).toEqual({
      orderId: expect.any(String),
      userId: expect.any(String),
      instrument: 'ABC',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.+Z$/),
    });
    const sorted = [...reserved].sort();
    expect(
      (await ids({ after: sorted[0] })).map(({ orderId }: { orderId: string }) => orderId),
    ).toEqual(sorted.slice(1));
    expect(await ids({ after: NIL, instrument: 'XYZ' })).toEqual([]);
    expect((await ids({ after: NIL, instrument: 'ABC' })).length).toBe(3);
  });

  it('rejects the page without a token and malformed bodies', async () => {
    expect((await live({ after: NIL }, {})).status).toBe(401);
    for (const body of [
      {},
      { after: 'x' },
      { after: NIL, instrument: 'NOPE' },
      { after: NIL, instrument: 1 },
      { after: NIL, extra: 1 },
    ])
      expect((await live(body)).status).toBe(400);
  });
});
