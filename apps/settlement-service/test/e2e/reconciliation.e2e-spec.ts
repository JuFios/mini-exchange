import { randomUUID } from 'node:crypto';
import { BadGatewayException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { EngineOrdersClient, TerminalOrder } from '../../src/reconciliation/engine-orders.client';
import { EngineTradesClient, Period } from '../../src/reconciliation/engine-trades.client';
import { EngineTrade } from '../../src/reconciliation/trade-comparison';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { TradesService } from '../../src/trades/trades.service';
import { ledgerApp } from '../ledger-app';
import { reserveTrade, type Trade } from '../stream-fixtures';

let engineTrades: EngineTrade[] = [];
let engineDelayMs = 0;
// Заявки, які engine вважає термінальними; решта заявок для нього відкриті.
let terminalOrders: TerminalOrder[] = [];
// Угоди першого тесту лишаються в тій самій БД.
const earlier: EngineTrade[] = [];
const ledger = ledgerApp(
  {},
  {
    customize: (builder) =>
      builder
        .overrideProvider(EngineOrdersClient)
        .useValue({
          terminal: async (ids: string[]) =>
            terminalOrders.filter(({ orderId }) => ids.includes(orderId)),
        })
        .overrideProvider(EngineTradesClient)
        .useValue({
          async *trades({ from, to, instrument }: Period) {
            await new Promise((resolve) => setTimeout(resolve, engineDelayMs));
            // Engine віддає угоди в порядку (executedAt, tradeId).
            const sorted = [...engineTrades].sort(
              (a, b) =>
                a.executedAt.localeCompare(b.executedAt) || a.tradeId.localeCompare(b.tradeId),
            );
            yield* sorted.filter(
              (trade) =>
                trade.executedAt >= from &&
                trade.executedAt < to &&
                (!instrument || trade.instrument === instrument),
            );
          },
        }),
  },
);
const source = () => ledger.source();
const admin = () =>
  new JwtService({ secret: ledger.jwtSecret }).sign(
    { sub: randomUUID(), typ: 'access', roles: ['admin'] },
    { expiresIn: '15m' },
  );
const report = async (query = '') =>
  (
    await request(ledger.app().getHttpServer())
      .get(
        `/admin/reconciliation?from=2026-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z${query}`,
      )
      .auth(admin(), { type: 'bearer' })
      .expect(200)
  ).body;

function trade(executedAt: string): Trade {
  return {
    tradeId: randomUUID(),
    instrument: 'ABC',
    buyOrderId: randomUUID(),
    sellOrderId: randomUUID(),
    buyerUserId: randomUUID(),
    sellerUserId: randomUUID(),
    baseAsset: 'ABC',
    quoteAsset: 'USD',
    price: '100.00',
    quantity: '0.5' as never,
    buyLimitPrice: '101.00',
    executedAt: executedAt as never,
  };
}
const asEngine = (t: Trade): EngineTrade => ({ ...t, quantity: '0.50000000' });

async function settle(t: Trade) {
  await reserveTrade(ledger.app(), t);
  await ledger.app().get(TradesService).settle(t);
}

it('is ok on a clean ledger, tolerates trades still within the grace period and validates the query', async () => {
  const good = trade('2026-01-01T10:00:00.000Z');
  await settle(good);
  earlier.push(asEngine(good));
  engineTrades = [asEngine(good), asEngine(trade(new Date().toISOString()))];
  const clean = await report();
  expect(clean).toMatchObject({
    ok: true,
    counts: { pending: 1, missing: 0, matched: 1, engineTrades: 2, ledgerTrades: 1 },
    perInstrument: [{ instrument: 'ABC', equal: false }],
  });
  expect((await report('&instrument=XYZ')).counts.engineTrades).toBe(0);
  await request(ledger.app().getHttpServer())
    .get('/admin/reconciliation?instrument=USD')
    .auth(admin(), { type: 'bearer' })
    .expect(400);
  await request(ledger.app().getHttpServer())
    .get('/admin/reconciliation?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z')
    .auth(admin(), { type: 'bearer' })
    .expect(400);
});

it('finds the intentionally broken trades and the leaked reservation', async () => {
  const good = trade('2026-01-01T10:00:00.000Z');
  const altered = trade('2026-01-01T10:00:01.000Z');
  const doubled = trade('2026-01-01T10:00:02.000Z');
  const orphan = trade('2026-01-01T10:00:03.000Z');
  const missing = trade('2026-01-01T10:00:04.000Z');
  const failed = trade('2026-01-01T10:00:05.000Z');
  const fresh = trade(new Date().toISOString());
  for (const t of [good, altered, doubled, orphan]) await settle(t);
  engineTrades = [...earlier, ...[good, altered, doubled, missing, failed, fresh].map(asEngine)];

  expect(await report()).toMatchObject({
    ok: false,
    counts: { orphan: 1, missing: 2, pending: 1, engineTrades: 7, ledgerTrades: 5, matched: 4 },
  });

  // Підміна суми проводки, дубль проводок, запис у DLQ і витік резерву.
  await source().query(
    `UPDATE postings SET amount=amount+1 WHERE id=(SELECT max(p.id) FROM postings p
       JOIN journal_entries j ON j.id=p.entry_id WHERE j.trade_id=$1)`,
    [altered.tradeId],
  );
  await source().query(
    `INSERT INTO postings (entry_id,account_id,asset,direction,amount)
     SELECT p.entry_id,p.account_id,p.asset,p.direction,p.amount FROM postings p
       JOIN journal_entries j ON j.id=p.entry_id WHERE j.trade_id=$1`,
    [doubled.tradeId],
  );
  await source().query(
    "INSERT INTO settlement_failures (stream,message_id,trade_id,reason,payload) VALUES ('s','1-0',$1,'x','{}')",
    [failed.tradeId],
  );
  await source().query(
    "UPDATE accounts SET balance=balance+7 WHERE user_id=$1 AND asset='USD' AND kind='reserved'",
    [good.buyerUserId],
  );
  engineTrades = engineTrades.filter(({ tradeId }) => tradeId !== missing.tradeId);

  const broken = await report();
  expect(broken.ok).toBe(false);
  expect(broken.counts).toMatchObject({
    amount_mismatch: 1,
    duplicate: 1,
    failed: 1,
    orphan: 1,
    pending: 1,
    reservation_leak: 1,
    missing: 0,
  });
  expect(broken.perAsset.find(({ asset }: { asset: string }) => asset === 'USD')).toMatchObject({
    balanced: false,
    replayMismatches: expect.any(Number),
  });
  expect(
    broken.discrepancies.find(({ type }: { type: string }) => type === 'reservation_leak'),
  ).toMatchObject({
    expected: { userId: good.buyerUserId },
    actual: { reserved: expect.any(String) },
  });
});

it('survives an engine slower than the default idle-in-transaction limit of the session', async () => {
  engineTrades = [];
  engineDelayMs = 11_000;
  try {
    // Без локальних лімітів PostgreSQL завершує сесію через 10 с простою в транзакції.
    expect((await report()).counts).toMatchObject({ engineTrades: 0 });
  } finally {
    engineDelayMs = 0;
  }
}, 30000);

it('refuses a second reconciliation while one holds the database connection', async () => {
  engineTrades = [];
  engineDelayMs = 700;
  try {
    const url = '/admin/reconciliation?from=2026-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z';
    const call = () =>
      request(ledger.app().getHttpServer()).get(url).auth(admin(), { type: 'bearer' });
    const statuses = (await Promise.all([call(), call()])).map((response) => response.status);
    expect(statuses.sort()).toEqual([200, 409]);
    await call().expect(200);
  } finally {
    engineDelayMs = 0;
  }
});

it('finds a reservation that stays active after its order closed and clears it after the release', async () => {
  engineTrades = [];
  const t = trade('2026-01-01T10:00:00.000Z');
  await reserveTrade(ledger.app(), t);
  const closedAt = (ageMs: number) => new Date(Date.now() - ageMs).toISOString();
  const closed = (orderId: string, ageMs: number): TerminalOrder => ({
    orderId,
    instrument: 'ABC',
    status: 'cancelled',
    closedAt: closedAt(ageMs),
  });
  // Купівля закрита давно, продаж — щойно: подія release для нього ще може бути в дорозі.
  terminalOrders = [closed(t.buyOrderId, 120_000), closed(t.sellOrderId, 1_000)];

  const stuck = await report();
  expect(stuck.ok).toBe(false);
  expect(stuck.counts.stuck_reservation).toBe(1);
  const found = stuck.discrepancies.filter(
    ({ type }: { type: string }) => type === 'stuck_reservation',
  );
  expect(found).toEqual([
    expect.objectContaining({
      tradeId: null,
      instrument: 'ABC',
      expected: { reservationId: t.buyOrderId, remaining: '0' },
      actual: expect.objectContaining({
        reservationId: t.buyOrderId,
        userId: t.buyerUserId,
        asset: 'USD',
        remaining: '505000000000',
        orderStatus: 'cancelled',
      }),
    }),
  ]);
  expect((await report('&instrument=XYZ')).counts.stuck_reservation).toBe(0);
  expect((await report('&instrument=ABC')).counts.stuck_reservation).toBe(1);

  await ledger.app().get(ReservationsService).release(t.buyOrderId);
  expect((await report()).counts.stuck_reservation).toBe(0);
  terminalOrders = [];
});

it('reports an unavailable engine order lookup instead of a clean reservation check', async () => {
  const t = trade('2026-01-01T10:00:00.000Z');
  await reserveTrade(ledger.app(), t);
  const orders = ledger.app().get(EngineOrdersClient);
  const lookup = jest.spyOn(orders, 'terminal').mockRejectedValue(new BadGatewayException());
  try {
    await request(ledger.app().getHttpServer())
      .get('/admin/reconciliation?from=2026-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z')
      .auth(admin(), { type: 'bearer' })
      .expect(502);
  } finally {
    lookup.mockRestore();
  }
});
