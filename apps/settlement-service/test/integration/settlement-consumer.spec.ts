import { once } from 'node:events';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import Redis from 'ioredis';
import { SettlementConsumer } from '../../src/consumer/settlement-consumer.service';
import { SettlementStats } from '../../src/consumer/settlement-stats';
import { DEAD_LETTER_STREAM } from '../../src/consumer/streams';
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

const ledger = ledgerApp();
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
