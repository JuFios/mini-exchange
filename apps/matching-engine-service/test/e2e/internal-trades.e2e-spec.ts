import Redis from 'ioredis';
import { waitFor } from '../helpers/wait-for';
import { engineApp } from './engine-app';

const api = engineApp();
const token = () => process.env.INTERNAL_API_TOKEN!;
const window = 'from=2000-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z';
const internal = (query: string, headers: Record<string, string> = {}) =>
  api.request(`/internal/trades?${window}${query}`, 'GET', undefined, undefined, headers);

async function admin(): Promise<string> {
  const response = await api.request('/auth/login', 'POST', undefined, {
    email: 'admin@demo.local',
    password: 'demo-admin-local-only',
  });
  return (await response.json()).accessToken;
}

/** Три угоди з однією ціною, але різною кількістю, між двома користувачами. */
async function trade(count: number) {
  const [seller, buyer] = await Promise.all([api.register(), api.register()]);
  for (let i = 0; i < count; i++) {
    expect((await api.submit(seller, { quantity: i + 1 })).status).toBe(201);
    expect((await api.submit(buyer, { side: 'buy', price: 101, quantity: i + 1 })).status).toBe(
      201,
    );
  }
}

it('rejects internal trade reads without a valid token of any length', async () => {
  expect((await internal('')).status).toBe(401);
  expect((await internal('', { 'x-internal-token': 'x'.repeat(token().length) })).status).toBe(401);
  expect((await internal('', { 'x-internal-token': 'x' })).status).toBe(401);
  expect((await internal('', { 'x-internal-token': token() })).status).toBe(200);
});

it('pages trades by execution time and trade ID with the data settlement needs', async () => {
  await trade(3);
  const headers = { 'x-internal-token': token() };
  const first = await (await internal('&limit=2', headers)).json();
  expect(first.trades).toHaveLength(2);
  expect(first.next).toMatch(/^\d{4}-.+Z,[0-9a-f-]{36}$/);
  const second = await (
    await internal(`&limit=2&after=${encodeURIComponent(first.next)}`, headers)
  ).json();
  expect(second.trades).toHaveLength(1);
  expect(second.next).toBeNull();

  const all = [...first.trades, ...second.trades];
  expect(all.map(({ quantity }) => quantity)).toEqual(['1.00000000', '2.00000000', '3.00000000']);
  const keys = all.map(({ executedAt, tradeId }) => `${executedAt},${tradeId}`);
  expect(keys).toEqual([...keys].sort());
  expect(all[0]).toMatchObject({
    instrument: 'ABC',
    price: '100.00',
    buyLimitPrice: '101.00',
    baseAsset: 'ABC',
    quoteAsset: 'USD',
  });
  expect(new Set(all.map(({ tradeId }) => tradeId)).size).toBe(3);
});

it('filters by instrument and period and rejects malformed parameters', async () => {
  await trade(1);
  const headers = { 'x-internal-token': token() };
  expect((await (await internal('&instrument=XYZ', headers)).json()).trades).toEqual([]);
  expect((await (await internal('&instrument=ABC', headers)).json()).trades).toHaveLength(1);
  const past = await api.request(
    '/internal/trades?from=2000-01-01T00:00:00.000Z&to=2001-01-01T00:00:00.000Z',
    'GET',
    undefined,
    undefined,
    headers,
  );
  expect((await past.json()).trades).toEqual([]);
  for (const query of [
    '&limit=0',
    '&limit=1001',
    '&instrument=NOPE',
    '&after=x',
    '&extra=1',
    '&after=2026-13-45T00:00:00.000Z,5a0a6d70-000e-4e19-a8b6-3cb26021396e',
  ])
    expect((await internal(query, headers)).status).toBe(400);
  expect(
    (
      await api.request(
        '/internal/trades?from=yesterday&to=now',
        'GET',
        undefined,
        undefined,
        headers,
      )
    ).status,
  ).toBe(400);
});

describe('outbox redrive', () => {
  let redis: Redis;
  const stream = 'exchange:settlement:{ABC}';
  const settlementEvents = async (tradeId: string) =>
    (await redis.xrange(stream, '-', '+')).filter(([, fields]) =>
      fields[fields.indexOf('envelope') + 1].includes(tradeId),
    );
  const row = async (tradeId: string) =>
    (
      await api
        .database()
        .query(
          "SELECT id,published_at FROM outbox WHERE type='trade.executed' AND payload->>'tradeId'=$1",
          [tradeId],
        )
    )[0];

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
    });
  });
  beforeEach(() => redis.del(stream));
  afterAll(async () => {
    await redis.del(stream);
    redis.disconnect();
  });

  it('publishes a trade event again at the tail of the outbox', async () => {
    await trade(1);
    const headers = { 'x-internal-token': token() };
    const [{ tradeId }] = (await (await internal('', headers)).json()).trades;
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
    const before = await row(tradeId);
    expect(await settlementEvents(tradeId)).toHaveLength(1);

    const response = await api.request('/admin/outbox/redrive', 'POST', await admin(), {
      tradeIds: [tradeId.toUpperCase(), '5a0a6d70-000e-4e19-a8b6-3cb26021396e'],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requeued: 1 });

    // Relay пише в Redis до COMMIT рядка outbox: подія в stream ще не означає published_at.
    await waitFor(async () => (await settlementEvents(tradeId)).length === 2);
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
    const after = await row(tradeId);
    expect(BigInt(after.id)).toBeGreaterThan(BigInt(before.id));
    expect(after.published_at).not.toBeNull();
    const [first, second] = await settlementEvents(tradeId);
    expect(second[1][second[1].indexOf('eventId') + 1]).toBe(
      first[1][first[1].indexOf('eventId') + 1],
    );
  });

  it('publishes the close event of a cancelled order again', async () => {
    const seller = await api.register();
    const { order } = await (await api.submit(seller)).json();
    expect((await api.request(`/orders/${order.id}`, 'DELETE', seller)).status).toBe(200);
    const closed = async () =>
      (await redis.xrange(stream, '-', '+')).filter(
        ([, fields]) => fields[fields.indexOf('type') + 1] === 'order.closed',
      );
    await waitFor(async () => (await closed()).length === 1);

    const response = await api.request('/admin/outbox/redrive', 'POST', await admin(), {
      orderIds: [order.id],
    });
    expect(await response.json()).toEqual({ requeued: 1 });
    await waitFor(async () => (await closed()).length === 2);
  });

  it('waits for an uncommitted owner insert so the relay never meets a lower position', async () => {
    await trade(1);
    const headers = { 'x-internal-token': token() };
    const [{ tradeId }] = (await (await internal('', headers)).json()).trades;
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
    // Рядок власника отримує id до redrive, але комітиться після нього.
    const owner = api.database().createQueryRunner();
    await owner.startTransaction();
    const [{ id }] = await owner.query(
      `INSERT INTO outbox (event_id, stream, type, version, instrument, seq, payload)
       VALUES (gen_random_uuid(), $1, 'order.closed', 1, 'ABC', 999, '{}') RETURNING id`,
      [stream],
    );
    try {
      const redrive = api.request('/admin/outbox/redrive', 'POST', await admin(), {
        tradeIds: [tradeId],
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await row(tradeId)).published_at).not.toBeNull();
      await owner.commitTransaction();
      expect((await (await redrive).json()).requeued).toBe(1);
    } finally {
      if (owner.isTransactionActive) await owner.rollbackTransaction();
      await owner.release();
    }
    const published = async () =>
      (await api.database().query('SELECT published_at FROM outbox WHERE id=$1', [id]))[0]
        ?.published_at;
    await waitFor(async () => (await published()) !== null);
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
  });

  it('lets owner inserts pass while it waits for a long transaction on the outbox', async () => {
    await trade(1);
    const [{ tradeId }] = (await (await internal('', { 'x-internal-token': token() })).json())
      .trades;
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
    const waiting = async () =>
      (
        await api.database().query(
          `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database
           WHERE d.datname = current_database() AND l.relation = 'outbox'::regclass
             AND l.mode = 'ShareRowExclusiveLock' AND NOT l.granted`,
        )
      )[0].n;
    const long = api.database().createQueryRunner();
    const owner = api.database().createQueryRunner();
    await long.startTransaction();
    await long.query('LOCK TABLE outbox IN ROW EXCLUSIVE MODE');
    try {
      const redrive = api.request('/admin/outbox/redrive', 'POST', await admin(), {
        tradeIds: [tradeId],
      });
      await waitFor(async () => (await waiting()) === 1);
      // Вставка власника бере те саме блокування таблиці й стає в чергу за redrive.
      const started = performance.now();
      await owner.startTransaction();
      await owner.query('LOCK TABLE outbox IN ROW EXCLUSIVE MODE');
      const waited = performance.now() - started;
      await owner.commitTransaction();
      expect(waited).toBeLessThan(1500);

      await long.commitTransaction();
      const response = await redrive;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ requeued: 1 });
    } finally {
      for (const runner of [owner, long]) {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    }
    await waitFor(async () => (await row(tradeId))?.published_at !== null);
  });

  it('validates the list of trade IDs', async () => {
    const token = await admin();
    for (const tradeIds of [
      [],
      ['x'],
      ['5a0a6d70-000e-4e19-a8b6-3cb26021396e', '5a0a6d70-000e-4e19-a8b6-3cb26021396e'],
    ])
      expect((await api.request('/admin/outbox/redrive', 'POST', token, { tradeIds })).status).toBe(
        400,
      );
    expect((await api.request('/admin/outbox/redrive', 'POST', token, {})).status).toBe(400);
    expect(
      (await api.request('/admin/outbox/redrive', 'POST', token, { orderIds: [] })).status,
    ).toBe(400);
  });

  it('rejects a null list of IDs instead of failing inside the handler', async () => {
    const token = await admin();
    const id = '5a0a6d70-000e-4e19-a8b6-3cb26021396e';
    for (const body of [
      { tradeIds: null },
      { orderIds: null },
      { tradeIds: null, orderIds: [id] },
      { tradeIds: [id], orderIds: null },
    ])
      expect((await api.request('/admin/outbox/redrive', 'POST', token, body)).status).toBe(400);
  });
});
