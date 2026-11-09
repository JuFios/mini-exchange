import { randomUUID } from 'node:crypto';
import { LedgerWriter } from '../../src/ledger/ledger-writer';
import { ReservationsService } from '../../src/reservations/reservations.service';
import { TradesService } from '../../src/trades/trades.service';
import { ledgerApp, tradeFixture } from '../ledger-app';

const ledger = ledgerApp();

it('settles a competing trade once across two connections released at a barrier', async () => {
  const app = ledger.app();
  const trade = tradeFixture();
  const reserves = app.get(ReservationsService);
  await reserves.reserve({
    reservationId: trade.buyOrderId,
    userId: trade.buyerUserId,
    instrument: 'ABC',
    limitPrice: trade.buyLimitPrice,
    asset: 'USD',
    amount: '505000000000',
  });
  await reserves.reserve({
    reservationId: trade.sellOrderId,
    userId: trade.sellerUserId,
    instrument: 'ABC',
    limitPrice: '0.01',
    asset: 'ABC',
    amount: '50000000',
  });
  const secondary = ledger.secondary();
  await secondary.initialize();
  try {
    const services = [app.get(TradesService), new TradesService(secondary, app.get(LedgerWriter))];
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const results = services.map(async (service) => {
      await barrier;
      return service.settle(trade);
    });
    releaseBarrier();
    const outcomes = await Promise.all(results);
    expect(outcomes.map(({ status }) => status).sort()).toEqual(['applied', 'duplicate']);
    const ids = outcomes.flatMap((outcome) => ('entryId' in outcome ? [outcome.entryId] : []));
    expect(new Set(ids).size).toBe(1);
    expect(
      await ledger
        .source()
        .query('SELECT id FROM journal_entries WHERE trade_id=$1', [trade.tradeId]),
    ).toEqual([{ id: ids[0] }]);
    const balances = await ledger
      .source()
      .query("SELECT kind,balance FROM accounts WHERE user_id=$1 AND asset='USD' ORDER BY kind", [
        trade.buyerUserId,
      ]);
    expect(balances).toEqual([
      { kind: 'available', balance: '999500000000000' },
      { kind: 'reserved', balance: '0' },
    ]);
  } finally {
    await secondary.destroy();
  }
});

function permutations(items: number[]): number[][] {
  if (!items.length) return [[]];
  return items.flatMap((item) =>
    permutations(items.filter((next) => next !== item)).map((tail) => [item, ...tail]),
  );
}

it('preserves the same balances for all 24 trade and partial release orders', async () => {
  const app = ledger.app();
  const reservations = app.get(ReservationsService);
  const trades = app.get(TradesService);
  const orders = permutations([0, 1, 2, 3]);
  expect(orders).toHaveLength(24);
  for (const order of orders) {
    const trade = tradeFixture();
    await reservations.reserve({
      reservationId: trade.buyOrderId,
      userId: trade.buyerUserId,
      instrument: 'ABC',
      limitPrice: trade.buyLimitPrice,
      asset: 'USD',
      amount: '2020000000000',
    });
    const fills = [
      { ...trade, quantity: '0.5', price: '100.00', sellLots: '50000000' },
      {
        ...trade,
        tradeId: randomUUID(),
        sellOrderId: randomUUID(),
        quantity: '0.5',
        price: '101.00',
        sellLots: '50000000',
      },
      {
        ...trade,
        tradeId: randomUUID(),
        sellOrderId: randomUUID(),
        quantity: '0.3',
        price: '99.00',
        sellLots: '30000000',
      },
    ];
    for (const fill of fills) {
      await reservations.reserve({
        reservationId: fill.sellOrderId,
        userId: trade.sellerUserId,
        instrument: 'ABC',
        limitPrice: '0.01',
        asset: 'ABC',
        amount: fill.sellLots,
      });
    }
    const apply = [
      ...fills.map((fill) => async () => {
        expect((await trades.settle(fill)).status).toBe('applied');
      }),
      async () => {
        await reservations.release(trade.buyOrderId, 707_000_000_000n);
      },
    ];
    for (const i of order) {
      await apply[i]();
      const reserved: { balance: string }[] = await ledger
        .source()
        .query("SELECT balance FROM accounts WHERE user_id=ANY($1::uuid[]) AND kind='reserved'", [
          [trade.buyerUserId, trade.sellerUserId],
        ]);
      expect(reserved.every(({ balance }) => BigInt(balance) >= 0n)).toBe(true);
      expect(
        await ledger.source().query(
          `
        SELECT a.user_id, a.asset FROM accounts a
        WHERE a.user_id = ANY($1::uuid[]) AND a.kind='reserved'
          AND a.balance <> COALESCE((
            SELECT SUM(r.remaining) FROM reservations r
            WHERE r.user_id=a.user_id AND r.asset=a.asset AND r.status='active'
          ), 0)
      `,
          [[trade.buyerUserId, trade.sellerUserId]],
        ),
      ).toEqual([]);
    }
    const expected = [
      { asset: 'ABC', kind: 'available', balance: '100130000000' },
      { asset: 'ABC', kind: 'reserved', balance: '0' },
      { asset: 'USD', kind: 'available', balance: '998698000000000' },
      { asset: 'USD', kind: 'reserved', balance: '0' },
    ];
    expect(
      await ledger
        .source()
        .query(
          "SELECT asset,kind,balance FROM accounts WHERE user_id=$1 AND asset IN ('ABC','USD') ORDER BY asset,kind",
          [trade.buyerUserId],
        ),
    ).toEqual(expected);
    expect(
      await ledger
        .source()
        .query(
          "SELECT asset,kind,balance FROM accounts WHERE user_id=$1 AND asset IN ('ABC','USD') ORDER BY asset,kind",
          [trade.sellerUserId],
        ),
    ).toEqual([
      { asset: 'ABC', kind: 'available', balance: '99870000000' },
      { asset: 'ABC', kind: 'reserved', balance: '0' },
      { asset: 'USD', kind: 'available', balance: '1001302000000000' },
      { asset: 'USD', kind: 'reserved', balance: '0' },
    ]);
  }
  expect(
    await ledger.source().query(`
    SELECT a.id FROM accounts a
    LEFT JOIN postings p ON p.account_id=a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(CASE p.direction WHEN 'credit' THEN p.amount ELSE -p.amount END), 0)
  `),
  ).toEqual([]);
  expect(
    await ledger.source().query(`
    SELECT asset FROM accounts GROUP BY asset HAVING SUM(balance) <> 0
  `),
  ).toEqual([]);
});

it('releases all that is still reserved after a partial release, including concurrent retries', async () => {
  const userId = randomUUID();
  const reservationId = randomUUID();
  const reserves = ledger.app().get(ReservationsService);
  await reserves.reserve({
    reservationId,
    userId,
    asset: 'ABC',
    amount: '100',
    instrument: 'ABC',
    limitPrice: '100.00',
  });
  await Promise.all([reserves.release(reservationId, 30n), reserves.release(reservationId, 30n)]);
  expect(
    await ledger
      .source()
      .query('SELECT remaining FROM reservations WHERE reservation_id=$1', [reservationId]),
  ).toEqual([{ remaining: '70' }]);
  await Promise.all([reserves.release(reservationId), reserves.release(reservationId)]);
  expect(
    await ledger
      .source()
      .query('SELECT remaining,status FROM reservations WHERE reservation_id=$1', [reservationId]),
  ).toEqual([{ remaining: '0', status: 'closed' }]);
  expect(
    await ledger
      .source()
      .query("SELECT balance FROM accounts WHERE user_id=$1 AND asset='ABC' AND kind='reserved'", [
        userId,
      ]),
  ).toEqual([{ balance: '0' }]);
  expect(
    await ledger
      .source()
      .query(
        "SELECT p.amount FROM postings p JOIN journal_entries j ON j.id=p.entry_id WHERE j.reservation_id=$1 AND j.type='release' AND p.direction='credit' ORDER BY p.id",
        [reservationId],
      ),
  ).toEqual([{ amount: '30' }, { amount: '70' }]);
});
