import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/database/migrate';
import { requestHash } from '../../src/ledger/ledger-writer';
import { backfillReservationTerms } from '../../src/reservations/backfill-reservation-terms';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { TradesService } from '../../src/trades/trades.service';
import { ledgerApp, tradeFixture } from '../ledger-app';

const ledger = ledgerApp();

it('restores active accepted reservation terms from stored engine orders across upgrades', async () => {
  const trade = tradeFixture();
  const reservations = ledger.app().get(ReservationsService);
  const trades = ledger.app().get(TradesService);
  const source = ledger.source();
  const buy = {
    reservationId: trade.buyOrderId,
    userId: trade.buyerUserId,
    instrument: 'ABC',
    asset: 'USD',
    amount: '505000000000',
    limitPrice: '101.00',
  } as const;
  const sell = {
    reservationId: trade.sellOrderId,
    userId: trade.sellerUserId,
    instrument: 'ABC',
    asset: 'ABC',
    amount: '50000000',
    limitPrice: '100.00',
  } as const;
  const orphan = { ...buy, reservationId: randomUUID() };
  for (const reservation of [buy, sell, orphan]) {
    await reservations.reserve(reservation);
    const { reservationId, userId, asset, amount } = reservation;
    await source.query('UPDATE reservations SET request_hash=$2 WHERE reservation_id=$1', [
      reservationId,
      requestHash({ userId, asset, amount }),
    ]);
  }
  await source.query(`
    CREATE TABLE instruments (symbol text PRIMARY KEY, base_asset text, quote_asset text);
    INSERT INTO instruments VALUES ('ABC','ABC','USD');
    CREATE TABLE orders (id uuid PRIMARY KEY, owner_id uuid, instrument text, side text, price numeric(18,2), quantity numeric(18,8));
    CREATE TABLE order_requests (order_id uuid PRIMARY KEY, status text);
  `);
  await source.query(
    "INSERT INTO orders VALUES ($1,$2,'ABC','buy',101,0.5),($3,$4,'ABC','sell',100,0.5)",
    [buy.reservationId, buy.userId, sell.reservationId, sell.userId],
  );
  await source.query("INSERT INTO order_requests VALUES ($1,'accepted'),($2,'accepted')", [
    buy.reservationId,
    sell.reservationId,
  ]);

  for (let attempt = 0; attempt < 2; attempt++) {
    await migrate(source, 'revert');
    for (const { reservationId, userId, asset, amount } of [buy, sell, orphan]) {
      expect(
        await source.query('SELECT request_hash FROM reservations WHERE reservation_id=$1', [
          reservationId,
        ]),
      ).toEqual([{ request_hash: requestHash({ userId, asset, amount }) }]);
    }
    await migrate(source, 'run');
    await backfillReservationTerms(source, () => ledger.secondary().initialize());
    await backfillReservationTerms(source, () => ledger.secondary().initialize());
    expect(
      await source.query(
        'SELECT instrument,limit_price_ticks FROM reservations WHERE reservation_id=$1',
        [buy.reservationId],
      ),
    ).toEqual([{ instrument: 'ABC', limit_price_ticks: '10100' }]);
    expect(
      await source.query(
        'SELECT instrument,limit_price_ticks FROM reservations WHERE reservation_id=$1',
        [orphan.reservationId],
      ),
    ).toEqual([{ instrument: null, limit_price_ticks: null }]);
  }

  expect((await trades.settle(trade)).status).toBe('applied');
  await expect(reservations.reserve(orphan)).resolves.toEqual({ status: 'accepted' });
  await expect(reservations.reserve({ ...orphan, limitPrice: '50.50' })).rejects.toMatchObject({
    response: { code: 'RESERVATION_CONFLICT' },
  });
  expect(
    await source.query(
      "SELECT count(*)::int AS entries FROM journal_entries WHERE reservation_id=$1 AND type='reserve'",
      [orphan.reservationId],
    ),
  ).toEqual([{ entries: 1 }]);
});

it('converts a reservation that commits concurrently with rollback to the legacy hash', async () => {
  const source = ledger.source();
  const reservation = {
    reservationId: randomUUID(),
    userId: randomUUID(),
    asset: 'ABC',
    amount: '100',
    instrument: 'ABC',
    limitPrice: '100.00',
  } as const;
  await ledger.app().get(ReservationsService).reserve(reservation);
  const concurrentId = randomUUID();
  const writer = source.createQueryRunner();
  let rollback: Promise<void> | undefined;
  try {
    await writer.startTransaction();
    await writer.query('UPDATE reservations SET remaining=remaining WHERE reservation_id=$1', [
      reservation.reservationId,
    ]);
    rollback = migrate(source, 'revert');
    void rollback.catch(() => undefined);
    let waiting = false;
    const deadline = performance.now() + 3000;
    while (!waiting && performance.now() < deadline) {
      [{ waiting }] = await source.query(
        `SELECT EXISTS (SELECT FROM pg_stat_activity
                        WHERE datname=current_database() AND wait_event_type='Lock'
                          AND query LIKE '%UPDATE reservations%request_hash%') AS waiting`,
      );
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await writer.query(
      `INSERT INTO reservations (reservation_id,user_id,asset,amount,remaining,status,request_hash,result,instrument,limit_price_ticks)
       SELECT $1,user_id,asset,amount,remaining,status,request_hash,result,instrument,limit_price_ticks
       FROM reservations WHERE reservation_id=$2`,
      [concurrentId, reservation.reservationId],
    );
    await writer.commitTransaction();
    await rollback;
    expect(
      await source.query('SELECT request_hash FROM reservations WHERE reservation_id=$1', [
        concurrentId,
      ]),
    ).toEqual([
      {
        request_hash: requestHash({
          userId: reservation.userId,
          asset: reservation.asset,
          amount: reservation.amount,
        }),
      },
    ]);
  } finally {
    if (writer.isTransactionActive) await writer.rollbackTransaction();
    await writer.release();
    await rollback?.then(
      async () => {
        await source.query('DELETE FROM reservations WHERE reservation_id=$1', [concurrentId]);
        await migrate(source, 'run');
        await ledger.app().get(ReservationsService).reserve(reservation);
      },
      () => undefined,
    );
  }
});
