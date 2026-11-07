import { InstrumentWorker } from '../../src/engine/instrument-worker';
import { engineApp } from './engine-app';

const { register, request, submit, database, app } = engineApp();

it('includes pending orders in active and filters all five lifecycle states', async () => {
  const owner = await register();
  const maker = await register();
  await submit(maker);
  const filled = (await (await submit(owner, { side: 'buy' })).json()).order;
  await submit(maker, { price: 99 });
  const partial = (await (await submit(owner, { side: 'buy', price: 99, quantity: 2 })).json()).order;
  const open = (await (await submit(owner, { side: 'buy', price: 98 })).json()).order;
  const cancelled = (await (await submit(owner, { side: 'buy', price: 97 })).json()).order;
  expect((await request(`/orders/${cancelled.id}`, 'DELETE', owner)).status).toBe(200);
  await app().get(InstrumentWorker).onModuleDestroy();
  const pendingResponse = await submit(owner, { side: 'buy', price: 96 });
  expect(pendingResponse.status).toBe(202);
  const pending = (await pendingResponse.json()).order;
  const get = async (status: string) => (await (await request(`/orders?status=${status}`, 'GET', owner)).json()) as { id: string }[];
  expect((await get('active')).map(({ id }) => id)).toEqual([pending.id, open.id, partial.id]);
  expect((await get('filled')).map(({ id }) => id)).toEqual([filled.id]);
  expect((await get('all')).map(({ id }) => id)).toEqual([pending.id, cancelled.id, open.id, partial.id, filled.id]);
});

it('paginates one hundred twenty orders in descending timestamp and UUID order without gaps or duplicates', async () => {
  const owner = await register();
  const userId = JSON.parse(Buffer.from(owner.split('.')[1], 'base64url').toString()).sub;
  await database().query(`INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,created_at)
    SELECT $1,'ABC','sell',100,1,1,'open',TIMESTAMPTZ '2026-11-01T00:00:00Z'+((i/10)::int)*INTERVAL '1 second'
    FROM generate_series(0,119) i`, [userId]);
  const expected = await database().query('SELECT id,created_at FROM orders ORDER BY created_at DESC,id DESC');
  const received: string[] = [];
  let cursor = '';
  const lengths: number[] = [];
  for (let page = 0; page < 3; page++) {
    const response = await request(`/orders?status=all&limit=50${cursor ? `&cursor=${cursor}` : ''}`, 'GET', owner);
    expect(response.status).toBe(200);
    const orders = await response.json();
    lengths.push(orders.length);
    received.push(...orders.map(({ id }: { id: string }) => id));
    const last = orders.at(-1);
    cursor = Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url');
  }
  expect(lengths).toEqual([50, 50, 20]);
  expect(received).toEqual(expected.map(({ id }: { id: string }) => id));
  expect(new Set(received).size).toBe(120);
  const duplicateTimes = await database().query('SELECT count(*)::int AS n FROM orders GROUP BY created_at');
  expect(duplicateTimes.every(({ n }: { n: number }) => n === 10)).toBe(true);
});

it.each(['status=bad', 'limit=0', 'limit=101', 'cursor=bad', 'instrument=UNKNOWN', 'userId=other'])('rejects invalid order queries %s', async (query) => {
  const owner = await register();
  expect((await request(`/orders?${query}`, 'GET', owner)).status).toBe(400);
});

it('returns the two latest public trades without private identifiers', async () => {
  const seller = await register();
  const buyer = await register();
  for (const price of [100, 101, 102]) {
    await submit(seller, { price });
    await submit(buyer, { price, side: 'buy' });
  }
  const response = await request('/instruments/ABC/trades?limit=2');
  expect(response.status).toBe(200);
  const trades = await response.json();
  expect(trades).toEqual([
    { tradeId: expect.any(String), seq: '6', price: '102.00', quantity: '1.00000000', takerSide: 'buy', executedAt: expect.any(String) },
    { tradeId: expect.any(String), seq: '4', price: '101.00', quantity: '1.00000000', takerSide: 'buy', executedAt: expect.any(String) },
  ]);
  expect((await request('/instruments/ABC/trades?limit=0')).status).toBe(400);
  expect((await request('/instruments/UNKNOWN/trades')).status).toBe(400);
});

it('starts the next test with no orders or restored depth from a preceding test', async () => {
  expect(await database().query('SELECT count(*)::int AS n FROM orders')).toEqual([{ n: 0 }]);
  expect(await (await request('/orders/book?instrument=ABC')).json()).toEqual({ instrument: 'ABC', seq: '0', bids: [], asks: [] });
});
