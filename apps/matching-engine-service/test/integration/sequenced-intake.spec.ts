import { engineApp } from '../e2e/engine-app';
import { ReferenceMatcher } from '../helpers/reference-matcher';
import { waitFor } from '../helpers/wait-for';

const api = engineApp();
const { register, request, submit, restart, database, build } = api;
const units = (text: string, scale: number) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
};

it('sequences two intake instances and matches all two hundred HTTP commands against an independent replay', async () => {
  const [a, b, c] = await Promise.all([register(), register(), register()]);
  const tokens = [a, b, c];
  const peer = await build({ ENGINE_WORKER_ENABLED: false, INSTANCE_ID: 'intake-peer' });
  try {
    const peerUrl = await peer.getUrl();
    const responses = await Promise.all(Array.from({ length: 200 }, (_, i) => {
      const body = { instrument: 'ABC', side: i % 2 ? 'buy' : 'sell', price: String(99 + i % 5), quantity: '1' };
      return i % 2 ? request('/orders', 'POST', tokens[i % 3], body, {}, 15000) : fetch(`${peerUrl}/orders`, {
        method: 'POST', headers: { Authorization: `Bearer ${tokens[i % 3]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    }));
    expect(responses.map(({ status }) => status).every((status) => status === 201 || status === 202)).toBe(true);
    await waitFor(async () => (await database().query('SELECT count(*)::int AS n FROM order_commands WHERE applied_at IS NOT NULL'))[0].n === 200, 10000);
    const commands = await database().query('SELECT * FROM order_commands ORDER BY seq');
    expect(commands.map((row: { seq: string }) => row.seq)).toEqual(Array.from({ length: 200 }, (_, i) => String(i + 1)));
    expect(new Set(commands.map((row: { order_id: string }) => row.order_id)).size).toBe(200);
    const reference = new ReferenceMatcher();
    const expected = [];
    for (const row of commands) {
      expected.push(...reference.apply({ type: 'submit', instrument: row.instrument, seq: BigInt(row.seq), acceptedAt: row.accepted_at.toISOString(), order: {
        id: row.order_id, ownerId: row.user_id, side: row.payload.side,
        price: units(row.payload.price, 2), quantity: units(row.payload.quantity, 8), remaining: units(row.payload.quantity, 8),
      } }).trades);
    }
    const trades = await database().query('SELECT * FROM trades ORDER BY seq,fill_index');
    expect(trades.map((row: Record<string, string | Date>) => ({
      tradeId: row.trade_id, buyOrderId: row.buyer_order_id, sellOrderId: row.seller_order_id,
      price: units(row.price as string, 2), quantity: units(row.quantity as string, 8), executedAt: (row.executed_at as Date).toISOString(), instrument: row.instrument,
    }))).toEqual(expected);
    const orders = await database().query('SELECT * FROM orders ORDER BY id');
    expect(orders.map((row: Record<string, string>) => ({ id: row.id, status: row.status, remaining: units(row.remaining_quantity, 8) })))
      .toEqual([...reference.orders.values()].sort((left, right) => left.id.localeCompare(right.id)).map(({ id, status, remaining }) => ({ id, status, remaining })));
    const resting = orders.filter((row: { status: string }) => ['open', 'partially_filled'].includes(row.status));
    const book = reference.book();
    expect(resting.map((row: { id: string }) => row.id).sort()).toEqual([...book.bids, ...book.asks].map(({ id }) => id).sort());
  } finally { await peer.close(); }
}, 30000);

it('deduplicates fifty concurrent cancellations and fifty submissions without sequence gaps', async () => {
  const owner = await register();
  const { order } = await (await submit(owner)).json();
  await restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 20 });
  const body = { instrument: 'ABC', side: 'sell', price: 101, quantity: 1 };
  const [cancels, submits] = await Promise.all([
    Promise.all(Array.from({ length: 50 }, () => request(`/orders/${order.id}`, 'DELETE', owner))),
    Promise.all(Array.from({ length: 50 }, () => request('/orders', 'POST', owner, body, { 'Idempotency-Key': 'duplicate' }))),
  ]);
  expect(cancels.every(({ status }) => status === 202)).toBe(true);
  const cancelBodies = await Promise.all(cancels.map((response) => response.json()));
  expect(new Set(cancelBodies.map((body) => JSON.stringify(body))).size).toBe(1);
  const submitBodies = await Promise.all(submits.map((response) => response.json()));
  expect(new Set(submitBodies.map((body) => JSON.stringify(body))).size).toBe(1);
  expect(await database().query('SELECT type,count(*)::int AS n FROM order_commands GROUP BY type ORDER BY type')).toEqual([{ type: 'cancel', n: 1 }, { type: 'submit', n: 2 }]);
  expect(await database().query('SELECT seq FROM order_commands ORDER BY seq')).toEqual([{ seq: '1' }, { seq: '2' }, { seq: '3' }]);
  expect(await database().query("SELECT next_seq FROM instruments WHERE symbol='ABC'")).toEqual([{ next_seq: '3' }]);
  await restart();
  expect(await database().query('SELECT count(*)::int AS n FROM order_commands WHERE applied_at IS NOT NULL')).toEqual([{ n: 3 }]);
});

it('wakes a synchronous waiter by NOTIFY before the fallback poll', async () => {
  await restart({ COMMAND_POLL_INTERVAL_MS: 10000, ORDER_SYNC_WAIT_MS: 800 });
  const token = await register();
  const started = performance.now();
  const response = await submit(token);
  expect(response.status).toBe(201);
  expect(performance.now() - started).toBeLessThan(800);
});

it('waits until timeout after losing LISTEN and reconnects the listener', async () => {
  await restart({ ENGINE_WORKER_ENABLED: false, ORDER_SYNC_WAIT_MS: 300 });
  const token = await register();
  const [{ pid }] = await database().query("SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'engine-listen:%' AND datname=current_database()");
  expect(pid).toBeGreaterThan(0);
  await database().query('SELECT pg_terminate_backend($1)', [pid]);
  const started = performance.now();
  const response = await submit(token);
  const elapsed = performance.now() - started;
  expect(response.status).toBe(202);
  expect(elapsed).toBeGreaterThanOrEqual(290);
  expect(elapsed).toBeLessThan(1000);
  await waitFor(async () => (await database().query("SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'engine-listen:%' AND datname=current_database() AND pid<>$1", [pid])).length === 1);
});

it('keeps independent waiters for submit and cancel sequences of the same order', async () => {
  const { PgNotifications } = await import('../../src/engine/pg-notifications');
  const notifications = api.app().get(PgNotifications);
  let first = false;
  let second = false;
  const a = notifications.wait('order', '1', 500);
  const b = notifications.wait('order', '2', 500);
  void a.ready.then(() => { first = true; });
  void b.ready.then(() => { second = true; });
  try {
    await database().query("SELECT pg_notify('order_applied','order:1')");
    await waitFor(async () => first);
    expect(second).toBe(false);
    await database().query("SELECT pg_notify('order_applied','order:2')");
    await b.ready;
    expect(second).toBe(true);
  } finally { a.cancel(); b.cancel(); }
});
