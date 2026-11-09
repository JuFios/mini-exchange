import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import type { Envelope } from '../../src/contracts/events';
import { OutboxRelay } from '../../src/outbox/outbox-relay.service';
import { marketStream, settlementStream, USER_EVENTS_STREAM } from '../../src/outbox/streams';
import { engineApp } from '../e2e/engine-app';
import { waitFor } from '../helpers/wait-for';

const api = engineApp();
const instruments = ['ABC', 'XYZ'];
const streams = [
  ...instruments.flatMap((i) => [marketStream(i), settlementStream(i)]),
  USER_EVENTS_STREAM,
];
let redis: Redis;

interface Row {
  event_id: string;
  stream: string;
  type: string;
  instrument: string;
  seq: string;
  payload: Record<string, unknown>;
  traceparent: string | null;
  created_at: Date;
  published_at: Date | null;
}

interface Entry {
  stream: string;
  fields: Record<string, string>;
  envelope: Envelope<Record<string, unknown>>;
}

beforeAll(async () => {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    commandTimeout: 3000,
    maxRetriesPerRequest: 0,
  });
  await redis.ping();
});

afterAll(() => redis?.disconnect());

async function stopAutomaticRelay() {
  await api.restart({}, (builder) => builder.overrideProvider(OutboxRelay).useValue({}));
}

function rows(): Promise<Row[]> {
  return api.database().query('SELECT * FROM outbox ORDER BY id');
}

async function entriesFor(outbox: Row[]): Promise<Entry[]> {
  const expected = new Set(outbox.map((row) => row.event_id));
  const entries = await Promise.all(
    streams.map(async (stream) =>
      (await redis.xrange(stream, '-', '+')).flatMap(([, fields]) => {
        const values = Object.fromEntries(
          Array.from({ length: fields.length / 2 }, (_, i) => fields.slice(2 * i, 2 * i + 2)),
        );
        return expected.has(values.eventId)
          ? [{ stream, fields: values, envelope: JSON.parse(values.envelope) }]
          : [];
      }),
    ),
  );
  return entries.flat();
}

function verifyDelivery(outbox: Row[], entries: Entry[], duplicate?: string) {
  expect(outbox.every(({ published_at }) => published_at instanceof Date)).toBe(true);
  const byId = new Map(outbox.map((row) => [row.event_id, row]));
  expect(entries.map(({ envelope }) => envelope.eventId).sort()).toEqual(
    [...byId.keys(), ...(duplicate ? [duplicate] : [])].sort(),
  );
  for (const { stream, fields, envelope } of entries) {
    const row = byId.get(envelope.eventId)!;
    expect(stream).toBe(row.stream);
    expect(fields).toEqual({
      eventId: row.event_id,
      type: row.type,
      version: '1',
      instrument: row.instrument,
      seq: row.seq,
      traceparent: row.traceparent ?? '',
      envelope: JSON.stringify(envelope),
    });
    expect(envelope).toEqual({
      eventId: row.event_id,
      type: row.type,
      version: 1,
      instrument: row.instrument,
      seq: row.seq,
      occurredAt: row.created_at.toISOString(),
      producer: 'matching-engine',
      ...(row.traceparent && { traceparent: row.traceparent }),
      payload: row.payload,
    });
  }
  for (const stream of streams) {
    for (const instrument of instruments) {
      const sequences = entries
        .filter((entry) => entry.stream === stream && entry.envelope.instrument === instrument)
        .map(({ envelope }) => BigInt(envelope.seq!));
      expect(sequences).toEqual([...sequences].sort((a, b) => (a < b ? -1 : Number(a > b))));
    }
  }
}

it.each([
  ['before-xadd', 'order.closed', false],
  ['after-xadd', 'trade.executed', true],
] as const)(
  'recovers every row after SIGKILL %s',
  async (window, eventType, appended) => {
    await stopAutomaticRelay();
    const [seller, buyer] = await Promise.all([api.register(), api.register()]);
    const sell = await api.submit(seller, { quantity: 2 });
    expect(sell.status).toBe(201);
    const { order } = await sell.json();
    expect((await api.submit(buyer, { side: 'buy', price: 101 })).status).toBe(201);
    expect((await api.request(`/orders/${order.id}`, 'DELETE', seller)).status).toBe(200);
    const outbox = await rows();
    expect(outbox.map(({ type }) => type)).toEqual([
      'book.delta',
      'order.updated',
      'book.delta',
      'order.updated',
      'order.updated',
      'trade.public',
      'trade.executed',
      'book.delta',
      'order.updated',
      'order.closed',
    ]);
    const target = outbox.find(({ type }) => type === eventType)!;
    expect(outbox.find(({ type }) => type === 'trade.executed')?.payload).toMatchObject({
      fillIndex: 0,
      baseAsset: 'ABC',
      quoteAsset: 'USD',
      price: '100.00',
      quantity: '1.00000000',
      quoteAmount: '1000000000000',
      buyLimitPrice: '101.00',
      sellOrderId: order.id,
      sellerUserId: order.ownerId,
    });
    expect(outbox.find(({ type }) => type === 'order.closed')?.payload).toEqual({
      orderId: order.id,
      userId: order.ownerId,
      instrument: 'ABC',
      seq: '3',
      side: 'sell',
      reason: 'cancelled',
      releasedAsset: 'ABC',
      releasedAmount: '100000000',
    });

    const child = fork(
      join(__dirname, '../helpers/outbox-relay-process.ts'),
      [target.event_id, window],
      {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env },
      },
    );
    const exited = once(child, 'exit');
    try {
      expect(await once(child, 'message', { signal: AbortSignal.timeout(8000) })).toEqual([
        { eventId: target.event_id, window },
      ]);
      const before = await rows();
      expect(before.find((row) => row.event_id === target.event_id)?.published_at).toBeNull();
      expect(
        (await entriesFor(outbox)).filter(({ fields }) => fields.eventId === target.event_id),
      ).toHaveLength(appended ? 1 : 0);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
    expect(await exited).toEqual([null, 'SIGKILL']);

    await api.restart();
    await waitFor(async () => (await rows()).every(({ published_at }) => published_at !== null));
    const recovered = await rows();
    expect(recovered.map(({ event_id }) => event_id)).toEqual(
      outbox.map(({ event_id }) => event_id),
    );
    verifyDelivery(recovered, await entriesFor(recovered), appended ? target.event_id : undefined);
  },
  20000,
);

async function enqueueCommands(seller: string, buyer: string, perInstrument: number) {
  await api.database().transaction(async (db) => {
    await db.query(
      `WITH commands AS (
         SELECT symbol, seq, gen_random_uuid() AS order_id,
                CASE WHEN seq % 2 = 1 THEN $1::uuid ELSE $2::uuid END AS user_id,
                CASE WHEN seq % 2 = 1 THEN 'sell' ELSE 'buy' END AS side
         FROM instruments CROSS JOIN generate_series(1, $3::integer) AS seq
       ), inserted AS (
         INSERT INTO orders (id, instrument, owner_id, side, price, quantity,
                             remaining_quantity, status, priority_seq, created_at)
         SELECT order_id, symbol, user_id, side, 100, 1, 1, 'pending', seq, now()
         FROM commands RETURNING id
       )
       INSERT INTO order_commands (instrument, seq, type, order_id, user_id, payload, traceparent)
       SELECT symbol, seq, 'submit', order_id, user_id,
              jsonb_build_object('side', side, 'price', '100.00', 'quantity', '1.00000000'), $4
       FROM commands JOIN inserted ON id = order_id`,
      [seller, buyer, perInstrument, '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'],
    );
    await db.query('UPDATE instruments SET next_seq = $1', [perInstrument]);
  });
}

it('discards a late append from a relay that lost its transaction while paused', async () => {
  await stopAutomaticRelay();
  await api
    .database()
    .query("SELECT setval(pg_get_serial_sequence('outbox', 'id'), $1)", ['18014398509481983']);
  const seller = await api.register();
  expect((await api.submit(seller)).status).toBe(201);
  expect((await api.submit(seller, { price: 101 })).status).toBe(201);
  const outbox = await rows();
  const target = outbox[0];
  expect(target).toMatchObject({ type: 'book.delta', seq: '1', published_at: null });
  const window = 'pause-before-xadd';
  const child = fork(
    join(__dirname, '../helpers/outbox-relay-process.ts'),
    [target.event_id, window],
    {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env },
    },
  );
  const exited = once(child, 'exit');
  try {
    expect(await once(child, 'message', { signal: AbortSignal.timeout(8000) })).toEqual([
      { eventId: target.event_id, window },
    ]);
    expect(child.kill('SIGSTOP')).toBe(true);
    await api.restart();
    await waitFor(
      async () => (await rows()).every(({ published_at }) => published_at !== null),
      10000,
    );
    const returned = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    child.send('resume');
    expect(child.kill('SIGCONT')).toBe(true);
    expect(await returned).toEqual([{ eventId: target.event_id, id: null }]);
    const delivered = await entriesFor(outbox);
    expect(
      delivered
        .filter(({ stream }) => stream === marketStream('ABC'))
        .map(({ envelope }) => envelope.seq),
    ).toEqual(['1', '2']);
    verifyDelivery(await rows(), delivered);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}, 25000);

it('keeps a row pending when Redis rejects XADD and publishes it after recovery', async () => {
  const stream = `exchange:outbox-test:${randomUUID()}`;
  const eventId = randomUUID();
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    await redis.set(stream, 'wrong-type');
    await api.database().query(
      `INSERT INTO outbox (event_id, stream, type, version, instrument, seq, payload)
       VALUES ($1, $2, 'book.delta', 1, 'ABC', 1, '{"instrument":"ABC","seq":"1","changes":[]}')`,
      [eventId, stream],
    );
    await waitFor(async () =>
      error.mock.calls.some(([entry]) => entry?.alert === 'outbox_publish_failed'),
    );
    expect(await rows()).toMatchObject([{ event_id: eventId, published_at: null }]);
    expect(await redis.get(stream)).toBe('wrong-type');

    await redis.del(stream);
    await waitFor(async () => (await rows())[0].published_at !== null);
    const entries = await redis.xrange(stream, '-', '+');
    expect(entries).toHaveLength(1);
    expect(entries[0][1].slice(0, 2)).toEqual(['eventId', eventId]);
  } finally {
    error.mockRestore();
    await redis.del(stream);
  }
});

it('serializes two competing relays and delivers all events for 1000 applied commands', async () => {
  await stopAutomaticRelay();
  await Promise.all([api.register(), api.register()]);
  const [seller, buyer] = await api
    .database()
    .query("SELECT id FROM users WHERE email LIKE '%@example.test' ORDER BY id LIMIT 2");
  await enqueueCommands(seller.id, buyer.id, 500);
  await waitFor(
    async () =>
      (
        await api
          .database()
          .query('SELECT count(*)::int AS count FROM order_commands WHERE applied_at IS NOT NULL')
      )[0].count === 1000,
    30000,
  );
  const outbox = await rows();
  expect(outbox).toHaveLength(3500);
  expect(outbox.every(({ published_at }) => published_at === null)).toBe(true);

  const source = await new DataSource(api.database().options).initialize();
  const config = new ConfigService({
    DATABASE_NAME: process.env.DATABASE_NAME,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: Number(process.env.REDIS_PORT),
    OUTBOX_POLL_INTERVAL_MS: 5,
    STREAM_MAXLEN: 1000000,
  });
  const first = new OutboxRelay(api.database(), config);
  const peer = new OutboxRelay(source, config);
  const attempts = jest.spyOn(source, 'transaction');
  const original = Redis.prototype.eval;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let active = 0;
  let peak = 0;
  const appends = jest.spyOn(Redis.prototype, 'eval').mockImplementation(async function (
    this: Redis,
    ...args: unknown[]
  ) {
    if (!streams.includes(args[3] as string)) return Reflect.apply(original, this, args);
    active++;
    peak = Math.max(peak, active);
    try {
      if (++calls === 1) await gate;
      return await Reflect.apply(original, this, args);
    } finally {
      active--;
    }
  } as Redis['eval']);
  try {
    first.onApplicationBootstrap();
    await waitFor(async () => calls === 1, 3000, 2);
    peer.onApplicationBootstrap();
    await waitFor(async () => attempts.mock.results.length > 0, 1000, 2);
    await expect(attempts.mock.results[0].value).resolves.toBe(false);
    expect(calls).toBe(1);
    const started = performance.now();
    release();
    await waitFor(
      async () =>
        (
          await api
            .database()
            .query('SELECT NOT EXISTS (SELECT 1 FROM outbox WHERE published_at IS NULL) AS drained')
        )[0].drained,
      30000,
      20,
    );
    process.stdout.write(
      `Published ${calls} stream entries in ${Math.round(performance.now() - started)} ms\n`,
    );
    expect(peak).toBe(1);
    expect(calls).toBe(3500);
  } finally {
    release();
    try {
      await Promise.all([first.onModuleDestroy(), peer.onModuleDestroy()]);
    } finally {
      appends.mockRestore();
      attempts.mockRestore();
      await source.destroy();
    }
  }

  const delivered = await entriesFor(outbox);
  verifyDelivery(await rows(), delivered);
  const seqs = Array.from({ length: 500 }, (_, i) => String(i + 1));
  for (const instrument of instruments) {
    const forInstrument = delivered.filter(({ envelope }) => envelope.instrument === instrument);
    const byType = (type: string) =>
      forInstrument
        .filter(({ envelope }) => envelope.type === type)
        .map(({ envelope }) => envelope.seq);
    expect(byType('book.delta')).toEqual(seqs);
    expect(byType('trade.public')).toEqual(seqs.filter((_, i) => i % 2 === 1));
    expect(byType('trade.executed')).toEqual(byType('trade.public'));
    expect(byType('order.updated')).toEqual(
      seqs.flatMap((seq, i) => (i % 2 === 1 ? [seq, seq] : [seq])),
    );
    for (const { envelope } of forInstrument.filter(
      ({ envelope }) => envelope.type === 'trade.public',
    )) {
      expect(Object.keys(envelope.payload).sort()).toEqual([
        'executedAt',
        'instrument',
        'price',
        'quantity',
        'seq',
        'takerSide',
        'tradeId',
      ]);
    }
  }
}, 65000);

it('publishes the oldest settlement event first while a sweeper locks it', async () => {
  await stopAutomaticRelay();
  const stream = settlementStream('ABC');
  const outbox = await api.database().query(
    `INSERT INTO outbox (event_id,stream,type,version,instrument,seq,payload)
     VALUES (gen_random_uuid(),$1,'order.closed',1,'ABC',1,'{}'),
            (gen_random_uuid(),$1,'trade.executed',1,'ABC',2,'{}')
     RETURNING id,event_id,stream`,
    [stream],
  );
  const config = new ConfigService({
    DATABASE_NAME: process.env.DATABASE_NAME,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: Number(process.env.REDIS_PORT),
    OUTBOX_POLL_INTERVAL_MS: 5,
    STREAM_MAXLEN: 1000000,
  });
  const relay = new OutboxRelay(api.database(), config);
  const holder = api.database().createQueryRunner();
  try {
    await holder.startTransaction();
    await holder.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    await holder.query('SELECT id FROM outbox WHERE id=$1 FOR UPDATE', [outbox[0].id]);
    relay.onApplicationBootstrap();
    await waitFor(async () => {
      const [state] = await api.database().query(
        `SELECT EXISTS (SELECT FROM pg_stat_activity
                        WHERE datname=current_database() AND wait_event_type='Lock'
                          AND query LIKE '%FROM outbox WHERE published_at IS NULL%') AS waiting`,
      );
      return state.waiting || (await entriesFor(outbox)).length > 0;
    }, 3000);
    expect(await entriesFor(outbox)).toEqual([]);
    await holder.commitTransaction();
    await waitFor(async () => (await entriesFor(outbox)).length === 2, 3000);
    expect((await entriesFor(outbox)).map(({ envelope }) => envelope.seq)).toEqual(['1', '2']);
    expect((await rows()).every(({ published_at }) => published_at instanceof Date)).toBe(true);
  } finally {
    if (holder.isTransactionActive) await holder.rollbackTransaction();
    await holder.release();
    await relay.onModuleDestroy();
  }
});
