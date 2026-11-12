import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import request from 'supertest';
import { SettlementConsumer } from '../../src/consumer/settlement-consumer.service';
import { SettlementStats } from '../../src/consumer/settlement-stats';
import { DEAD_LETTER_STREAM, SETTLEMENT_STREAMS } from '../../src/consumer/streams';
import { EngineOrdersClient } from '../../src/reconciliation/engine-orders.client';
import { EngineTradesClient } from '../../src/reconciliation/engine-trades.client';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import type { EngineTrade } from '../../src/reconciliation/trade-comparison';
import { WalletPublisher } from '../../src/wallets/wallet-publisher';
import { ledgerApp, tradeFixture } from '../ledger-app';
import {
  abcStream,
  pendingCount,
  redisClient,
  reserveTrade as reserve,
  resetStreams,
  startConsumer,
  streamFields,
  type Trade,
  tradeFields,
  USER_EVENTS,
} from '../stream-fixtures';

// Engine знає про всі угоди, тож звірка бачить ті, чий запис обрізано з stream.
let known: EngineTrade[] = [];
const ledger = ledgerApp(
  {},
  {
    customize: (builder) =>
      builder
        .overrideProvider(EngineOrdersClient)
        .useValue({ terminal: async () => [] })
        .overrideProvider(EngineTradesClient)
        .useValue({
          async *trades() {
            yield* known;
          },
        }),
  },
);
let redis: Redis;
let consumer: SettlementConsumer | undefined;
const source = () => ledger.source();
// Резервування теж публікує wallet.updated; тести перевіряють лише push розрахунку.
const reserveTrade = async (app: Parameters<typeof reserve>[0], trade: Trade) => {
  await reserve(app, trade);
  await redis.del(USER_EVENTS);
};
const until = async <T>(read: () => Promise<T>, accepts: (value: T) => boolean, ms = 8000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accepts(value)) return value;
    if (Date.now() > deadline) throw new Error(`Condition timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const entries = async (trade: { tradeId: string }) =>
  source().query('SELECT id FROM journal_entries WHERE trade_id=$1', [trade.tradeId]);
const walletEvents = async () =>
  (await redis.xrange(USER_EVENTS, '-', '+')).map(([, fields]) => {
    const envelope = JSON.parse(fields[fields.indexOf('envelope') + 1]);
    return envelope.payload as { userId: string; asset: string; version: string; entryId: string };
  });

beforeAll(() => {
  redis = redisClient();
});
beforeEach(async () => {
  await resetStreams(redis);
  await source().query('TRUNCATE settlement_failures');
});
afterEach(async () => {
  await consumer?.beforeApplicationShutdown();
  consumer = undefined;
});
afterAll(async () => {
  await resetStreams(redis);
  redis.disconnect();
});

it('scans the pending list once per idle window rather than before every batch', async () => {
  // 120 записів — щонайменше три пачки XREADGROUP по 50; невідомий тип одразу йде в DLQ.
  for (let index = 0; index < 120; index++)
    await redis.xadd(abcStream, '*', ...streamFields('unknown.event', {}));
  consumer = startConsumer(ledger.app(), { claimIdleMs: 60_000 });
  const claims = jest.spyOn(consumer['redis'], 'xautoclaim');

  await until(
    () => consumer!.queue(),
    ({ streams, deadLetters }) =>
      deadLetters === 120 && streams.every(({ lag, pending }) => lag === 0 && pending === 0),
  );
  // Один прохід на старті для кожного stream; наступний настане лише через 30 с.
  expect(claims).toHaveBeenCalledTimes(SETTLEMENT_STREAMS.length);
});

it('returns in GET /wallets the same version that the pushed wallet.updated carries', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...tradeFields(trade));
  const pushed = await until(walletEvents, (events) => events.length === 4);

  const jwt = new JwtService({ secret: ledger.jwtSecret });
  for (const { userId, asset, version } of pushed) {
    const access = jwt.sign(
      { sub: userId, sid: randomUUID(), typ: 'access' },
      { expiresIn: '15m' },
    );
    const response = await request(ledger.app().getHttpServer())
      .get('/wallets')
      .auth(access, { type: 'bearer' })
      .expect(200);
    expect(response.body.find((wallet: { asset: string }) => wallet.asset === asset)).toMatchObject(
      { version },
    );
  }
});

it('settles a published trade, pushes all four wallets and acknowledges the record', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...tradeFields(trade));

  await until(
    () => entries(trade),
    (rows) => rows.length === 1,
  );
  const pushed = await until(walletEvents, (events) => events.length === 4);
  expect(pushed.map(({ userId, asset }) => `${userId}:${asset}`).sort()).toEqual(
    [
      [trade.buyerUserId, 'ABC'],
      [trade.buyerUserId, 'USD'],
      [trade.sellerUserId, 'ABC'],
      [trade.sellerUserId, 'USD'],
    ]
      .map((parts) => parts.join(':'))
      .sort(),
  );
  await until(
    () => pendingCount(redis),
    (pending) => pending === 0,
  );
});

it('applies a redelivered trade once but still pushes the current wallets', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...tradeFields(trade));
  await until(walletEvents, (events) => events.length === 4);
  const before = await walletEvents();

  await redis.xadd(abcStream, '*', ...tradeFields(trade));
  const after = await until(walletEvents, (events) => events.length === 8);

  expect(await entries(trade)).toHaveLength(1);
  expect(ledger.app().get(SettlementStats).trades).toMatchObject({ duplicate: 1 });
  expect(after.slice(4).map(({ version, entryId }) => [version, entryId])).toEqual(
    before.map(({ version, entryId }) => [version, entryId]),
  );
});

it('releases the unfilled remainder from an order close event exactly once', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  const close = streamFields('order.closed', {
    orderId: trade.sellOrderId,
    userId: trade.sellerUserId,
    instrument: 'ABC',
    side: 'sell',
    reason: 'cancelled',
    releasedAsset: 'ABC',
    releasedAmount: '20000000',
    seq: '1',
  });
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...close);
  await redis.xadd(abcStream, '*', ...close);
  await until(
    () => consumer!.queue(),
    ({ streams }) => streams.every(({ lag, pending }) => lag === 0 && pending === 0),
  );

  expect(
    await source().query(
      "SELECT kind,balance FROM accounts WHERE user_id=$1 AND asset='ABC' ORDER BY kind",
      [trade.sellerUserId],
    ),
  ).toEqual([
    { kind: 'available', balance: '99970000000' },
    { kind: 'reserved', balance: '30000000' },
  ]);
});

const closeFields = (trade: Trade) =>
  streamFields('order.closed', {
    orderId: trade.sellOrderId,
    userId: trade.sellerUserId,
    instrument: 'ABC',
    side: 'sell',
    reason: 'cancelled',
    releasedAsset: 'ABC',
    releasedAmount: '20000000',
    seq: '1',
  });
const releaseEntries = (trade: Trade) =>
  source().query('SELECT id::text AS id FROM journal_entries WHERE operation_id=$1', [
    `release:${trade.sellOrderId}`,
  ]);

it('pushes the released wallet for an order close and again for its redelivery', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...closeFields(trade));
  const [first] = await until(walletEvents, (events) => events.length === 1);
  const [{ id: entryId }] = await releaseEntries(trade);
  expect(first).toMatchObject({
    userId: trade.sellerUserId,
    asset: 'ABC',
    available: '999.70000000',
    reserved: '0.30000000',
    entryId,
  });

  await redis.xadd(abcStream, '*', ...closeFields(trade));
  const pushed = await until(walletEvents, (events) => events.length === 2);

  expect(pushed[1]).toEqual(first);
  expect(await releaseEntries(trade)).toHaveLength(1);
});

it('keeps an order close pending until its wallet push reaches the stream', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  const append = jest
    .spyOn(ledger.app().get(WalletPublisher) as never, 'append')
    .mockRejectedValueOnce(new Error('Connection is closed.') as never);
  try {
    consumer = startConsumer(ledger.app());
    await redis.xadd(abcStream, '*', ...closeFields(trade));

    const pushed = await until(walletEvents, (events) => events.length >= 1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ userId: trade.sellerUserId, reserved: '0.30000000' });
    await until(
      () => pendingCount(redis),
      (pending) => pending === 0,
    );
    expect(await releaseEntries(trade)).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(2);
  } finally {
    append.mockRestore();
  }
});

it('dead-letters an invalid record at once and a conflicting trade without moving funds', async () => {
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...tradeFields(trade));
  await until(
    () => entries(trade),
    (rows) => rows.length === 1,
  );
  await redis.xadd(abcStream, '*', ...tradeFields({ ...trade, quantity: '0.4' as never }));
  await redis.xadd(abcStream, '*', 'envelope', 'not json');

  await until(
    () => redis.xlen(DEAD_LETTER_STREAM),
    (length) => length === 2,
  );
  await until(
    () => pendingCount(redis),
    (pending) => pending === 0,
  );
  expect(await entries(trade)).toHaveLength(1);
  const failures = await source().query(
    'SELECT stream,trade_id,reason FROM settlement_failures ORDER BY id',
  );
  expect(failures).toEqual([
    { stream: abcStream, trade_id: trade.tradeId, reason: 'Trade payload conflict' },
    { stream: abcStream, trade_id: null, reason: 'Envelope is not valid JSON' },
  ]);
});

it('dead-letters malformed trade identifiers and still settles the next valid trade once', async () => {
  const valid = tradeFixture();
  await reserveTrade(ledger.app(), valid);
  const invalidIds: unknown[] = [
    '-'.repeat(36),
    'a'.repeat(36),
    '12345678-1234-1234-1234-12345678901-',
    'not-a-uuid',
    valid.tradeId + '\n',
    null,
    123,
    { value: valid.tradeId },
  ];
  const records = invalidIds.map((tradeId) =>
    streamFields('trade.executed', { ...valid, tradeId }),
  );
  consumer = startConsumer(ledger.app());
  for (const fields of records) await redis.xadd(abcStream, '*', ...fields);
  await redis.xadd(abcStream, '*', ...tradeFields(valid));
  await redis.xadd(abcStream, '*', ...tradeFields(valid));
  await until(
    () => consumer!.queue(),
    ({ streams, deadLetters }) =>
      deadLetters === invalidIds.length &&
      streams.every(({ lag, pending }) => lag === 0 && pending === 0),
  );

  const failures = await source().query(
    'SELECT trade_id,payload FROM settlement_failures ORDER BY id',
  );
  expect(failures.map(({ trade_id }: { trade_id: string | null }) => trade_id)).toEqual(
    invalidIds.map(() => null),
  );
  expect(
    failures.map(
      ({ payload }: { payload: { fields: { envelope: string } } }) =>
        JSON.parse(payload.fields.envelope).payload.tradeId,
    ),
  ).toEqual(invalidIds);
  expect(await entries(valid)).toHaveLength(1);
});

it('preserves canonical trade identifiers in rejected records regardless of UUID version or case', async () => {
  const ids = [
    randomUUID().toUpperCase(),
    '00000000-0000-0000-0000-000000000000',
    'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  ];
  consumer = startConsumer(ledger.app());
  for (const tradeId of ids) {
    await redis.xadd(
      abcStream,
      '*',
      ...streamFields('trade.executed', { ...tradeFixture(), tradeId }, 'invalid-producer'),
    );
  }
  await until(
    () => consumer!.queue(),
    ({ streams, deadLetters }) =>
      deadLetters === ids.length && streams.every(({ lag, pending }) => lag === 0 && pending === 0),
  );
  const failures: { trade_id: string }[] = await source().query(
    'SELECT trade_id FROM settlement_failures ORDER BY id',
  );
  expect(failures.map(({ trade_id }) => trade_id)).toEqual(ids.map((id) => id.toLowerCase()));
});

it('keeps a malformed trade identifier and unstoreable JSON in an encoded dead letter', async () => {
  const fields = streamFields('trade.executed', {
    ...tradeFixture(),
    tradeId: '-'.repeat(36),
  });
  fields.push('diagnostic', '\u0000');
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...fields);
  await until(
    () => consumer!.queue(),
    ({ streams, deadLetters }) =>
      deadLetters === 1 && streams.every(({ lag, pending }) => lag === 0 && pending === 0),
  );
  const [failure] = await source().query('SELECT trade_id,payload FROM settlement_failures');
  expect(failure.trade_id).toBeNull();
  expect(failure.payload.encoding).toBe('base64');
  expect(JSON.parse(Buffer.from(failure.payload.fields, 'base64').toString('utf8'))).toEqual(
    fields,
  );
});

it('keeps a record that jsonb cannot store by dead-lettering an encoded copy', async () => {
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', 'envelope', 'bad\u0000record');

  await until(
    () => redis.xlen(DEAD_LETTER_STREAM),
    (length) => length === 1,
  );
  const [failure] = await source().query('SELECT payload FROM settlement_failures');
  expect(failure.payload.encoding).toBe('base64');
  expect(await pendingCount(redis)).toBe(0);
});

it('never dead-letters a transient failure, however many times it is delivered', async () => {
  let calls = 0;
  const flaky = {
    async handle() {
      if (++calls <= 5)
        throw Object.assign(new Error('deadlock'), { driverError: { code: '40P01' } });
    },
  };
  consumer = startConsumer(ledger.app(), { claimIdleMs: 50, maxDeliveries: 2 }, flaky);
  await redis.xadd(abcStream, '*', ...tradeFields(tradeFixture()));

  await until(
    () => pendingCount(redis),
    (pending) => pending === 0 && calls > 5,
    15000,
  );
  expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(0);
  expect(ledger.app().get(SettlementStats).transientFailures).toBeGreaterThanOrEqual(5);
});

it('dead-letters an unclassified failure after the delivery limit', async () => {
  let calls = 0;
  consumer = startConsumer(
    ledger.app(),
    { claimIdleMs: 50, maxDeliveries: 3 },
    {
      async handle() {
        calls++;
        throw new Error('boom');
      },
    },
  );
  await redis.xadd(abcStream, '*', ...tradeFields(tradeFixture()));

  await until(
    () => redis.xlen(DEAD_LETTER_STREAM),
    (length) => length === 1,
  );
  expect(calls).toBe(3);
  expect(await pendingCount(redis)).toBe(0);
});

it('survives a trimmed pending record and settles the records after it', async () => {
  const lost = tradeFixture();
  await redis.xgroup('CREATE', abcStream, 'settlement', '0', 'MKSTREAM');
  await redis.xadd(abcStream, '*', ...tradeFields(lost));
  await redis.xreadgroup('GROUP', 'settlement', 'crashed', 'COUNT', 1, 'STREAMS', abcStream, '>');
  expect(await pendingCount(redis)).toBe(1);
  await redis.xtrim(abcStream, 'MAXLEN', 0);

  const next = tradeFixture();
  await reserveTrade(ledger.app(), next);
  const before = ledger.app().get(SettlementStats).trimmedPending;
  consumer = startConsumer(ledger.app());
  await redis.xadd(abcStream, '*', ...tradeFields(next));

  await until(
    () => entries(next),
    (rows) => rows.length === 1,
  );
  expect(ledger.app().get(SettlementStats).trimmedPending).toBe(before + 1);
  expect(await entries(lost)).toHaveLength(0);
  known = [lost, next]
    .map((trade) => ({ ...trade, quantity: '0.50000000' }))
    .sort((a, b) => a.tradeId.localeCompare(b.tradeId));
  const report = await ledger
    .app()
    .get(ReconciliationService)
    .run({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
  // Попередні тести залишили в ledger інші угоди, тож перевіряємо лише клас missing.
  expect(
    report.discrepancies.filter(({ type }) => type === 'missing').map(({ tradeId }) => tradeId),
  ).toEqual([lost.tradeId]);
  await until(
    () => pendingCount(redis),
    (pending) => pending === 0,
  );
});

it('recreates the group and keeps consuming after the stream is deleted', async () => {
  consumer = startConsumer(ledger.app());
  await until(
    () => redis.exists(abcStream),
    (exists) => exists === 1,
  );
  await redis.del(abcStream);
  const trade = tradeFixture();
  await reserveTrade(ledger.app(), trade);
  await new Promise((resolve) => setTimeout(resolve, 600));
  await redis.xadd(abcStream, '*', ...tradeFields(trade));

  await until(
    () => entries(trade),
    (rows) => rows.length === 1,
  );
});

describe.each(['before-ack', 'before-wallet-push'] as const)(
  'recovers from a crash %s',
  (window) => {
    it('settles once and publishes the wallets of the recovered record', async () => {
      const trade = tradeFixture();
      await reserveTrade(ledger.app(), trade);
      await redis.xadd(abcStream, '*', ...tradeFields(trade));
      const child = fork(join(__dirname, '../helpers/consumer-process.ts'), [window], {
        execArgv: ['-r', 'ts-node/register/transpile-only'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: { ...process.env },
      });
      const exited = once(child, 'exit');
      try {
        expect(await once(child, 'message', { signal: AbortSignal.timeout(10000) })).toEqual([
          { window },
        ]);
        expect(await entries(trade)).toHaveLength(1);
        expect(await pendingCount(redis)).toBe(1);
      } finally {
        child.kill('SIGKILL');
      }
      expect(await exited).toEqual([null, 'SIGKILL']);

      consumer = startConsumer(ledger.app());
      await until(
        () => pendingCount(redis),
        (pending) => pending === 0,
      );
      expect(await entries(trade)).toHaveLength(1);
      expect(
        await source().query(
          'SELECT count(*)::int AS n FROM postings WHERE entry_id=(SELECT id FROM journal_entries WHERE trade_id=$1)',
          [trade.tradeId],
        ),
      ).toEqual([{ n: 5 }]);
      const pushed = await walletEvents();
      // Після збою перед ACK push уже був, і повтор публікує ті самі версії вдруге.
      expect(pushed).toHaveLength(window === 'before-ack' ? 8 : 4);
      const current = await source().query(
        "SELECT user_id,asset,sum(version)::text AS version FROM accounts WHERE user_id=ANY($1) AND asset IN ('ABC','USD') AND kind IN ('available','reserved') GROUP BY user_id,asset",
        [[trade.buyerUserId, trade.sellerUserId]],
      );
      for (const event of pushed)
        expect(current).toContainEqual({
          user_id: event.userId,
          asset: event.asset,
          version: event.version,
        });
    }, 30000);
  },
);

it('reports queue depth, lag and failures', async () => {
  consumer = startConsumer(ledger.app());
  await until(
    () => redis.exists(abcStream),
    (exists) => exists === 1,
  );
  const info = await consumer.queue();
  expect(info.streams.find(({ stream }) => stream === abcStream)).toMatchObject({
    length: 0,
    pending: 0,
    lag: 0,
  });
  expect(info).toMatchObject({ deadLetters: 0, failures: 0, consumer: 'test-consumer' });
});

// Детермінований генератор: однакове насіння відтворює ту саму послідовність доставок.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

it.each([20261105, 7, 99])(
  'keeps the ledger consistent for duplicated, shuffled and restarted deliveries (seed %i)',
  async (seed) => {
    const random = mulberry32(seed);
    const trades = Array.from({ length: 12 }, () => tradeFixture());
    for (const trade of trades) await reserveTrade(ledger.app(), trade);
    const deliveries = trades
      .flatMap((trade) => Array.from({ length: 1 + Math.floor(random() * 3) }, () => trade))
      .sort(() => random() - 0.5);
    known = trades
      .map((trade) => ({ ...trade, quantity: '0.50000000' }))
      .sort((a, b) => a.tradeId.localeCompare(b.tradeId));

    consumer = startConsumer(ledger.app());
    for (const [index, trade] of deliveries.entries()) {
      await redis.xadd(abcStream, '*', ...tradeFields(trade));
      if (index === Math.floor(deliveries.length / 2)) {
        // Рестарт посеред потоку: незавершені записи повертаються через reclaim.
        await consumer.beforeApplicationShutdown();
        consumer = startConsumer(ledger.app());
      }
    }
    await until(
      () => consumer!.queue(),
      ({ streams }) => streams.every(({ lag, pending }) => lag === 0 && pending === 0),
      15000,
    );

    expect(
      await source().query(
        'SELECT count(*)::int AS n FROM journal_entries WHERE trade_id = ANY($1)',
        [trades.map(({ tradeId }) => tradeId)],
      ),
    ).toEqual([{ n: trades.length }]);
    expect(await redis.xlen(DEAD_LETTER_STREAM)).toBe(0);
    // Кожна угода застосована один раз: звірка не знаходить ні дублів, ні витоку резерву.
    const report = await ledger
      .app()
      .get(ReconciliationService)
      .run({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' });
    expect(report.counts).toMatchObject({ duplicate: 0, amount_mismatch: 0, reservation_leak: 0 });
    expect(
      report.perAsset.every(
        ({ balanced, balanceSum, replayMismatches }) =>
          balanced && balanceSum === '0' && replayMismatches === 0,
      ),
    ).toBe(true);
  },
  30000,
);
