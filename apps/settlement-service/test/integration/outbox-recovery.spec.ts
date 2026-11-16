import { QueryRunner } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { EngineOutboxClient } from '../../src/consumer/engine-outbox.client';
import { SettlementEventHandler } from '../../src/consumer/settlement-event.handler';
import { ledgerApp, tradeFixture } from '../ledger-app';
import { reserveTrade, streamFields } from '../stream-fixtures';

const events: { position: string; envelope: string }[] = [];
const ledger = ledgerApp(
  {},
  {
    customize: (builder) =>
      builder.overrideProvider(EngineOutboxClient).useValue({
        event: async (raw: string) => {
          const eventId = JSON.parse(raw).eventId;
          const found = events.find((row) => JSON.parse(row.envelope).eventId === eventId);
          if (!found) throw new Error('Uncommitted event');
          return found;
        },
        page: async (instrument: string, after: string) =>
          instrument === 'ABC' ? events.filter((row) => BigInt(row.position) > BigInt(after)) : [],
      }),
  },
);

it('recovers the exact ledger after an interrupted checkpoint and concurrent redelivery without Redis payloads', async () => {
  const trade = { ...tradeFixture(), quantity: '0.25' };
  await reserveTrade(ledger.app(), { ...trade, quantity: '0.5' });
  const payloads: [string, object][] = [
    ['trade.executed', trade],
    [
      'order.closed',
      {
        orderId: trade.buyOrderId,
        userId: trade.buyerUserId,
        releasedAsset: 'USD',
        releasedAmount: '252500000000',
      },
    ],
    [
      'order.closed',
      {
        orderId: trade.sellOrderId,
        userId: trade.sellerUserId,
        releasedAsset: 'ABC',
        releasedAmount: '25000000',
      },
    ],
  ];
  events.push(
    ...payloads.map(([type, payload], index) => {
      const fields = streamFields(type, payload);
      return { position: String(index + 1), envelope: fields.at(-1)! };
    }),
  );
  const source = ledger.source();
  const query = source.query.bind(source);
  let interrupted = false;
  const spy = jest
    .spyOn(source, 'query')
    .mockImplementation(async (sql: string, args?: unknown[], runner?: QueryRunner) => {
      if (sql.includes('INSERT INTO settlement_progress') && !interrupted) {
        interrupted = true;
        throw new Error('Interrupted after ledger COMMIT');
      }
      return query(sql, args, runner);
    });
  const handler = ledger.app().get(SettlementEventHandler);
  await expect(handler.recover(() => false)).rejects.toThrow('Interrupted');
  expect(await query('SELECT * FROM settlement_progress')).toEqual([]);
  spy.mockRestore();
  await Promise.all([handler.recover(() => false), handler.recover(() => false)]);
  expect(await query('SELECT position FROM settlement_progress')).toEqual([{ position: '3' }]);
  expect(await query("SELECT count(*)::int AS n FROM journal_entries WHERE type='trade'")).toEqual([
    { n: 1 },
  ]);
  expect(
    await query("SELECT count(*)::int AS n FROM journal_entries WHERE type='release'"),
  ).toEqual([{ n: 2 }]);
  expect(
    await query("SELECT sum(balance)::text AS balance FROM accounts WHERE kind='reserved'"),
  ).toEqual([{ balance: '0' }]);
  const balances = await query('SELECT id,balance,version FROM accounts ORDER BY id');
  await handler.handle(
    'forged',
    JSON.stringify({
      eventId: JSON.parse(events[0].envelope).eventId,
      payload: { tradeId: randomUUID(), quantity: '999' },
    }),
  );
  await handler.recover(() => false);
  expect(await query('SELECT id,balance,version FROM accounts ORDER BY id')).toEqual(balances);
});
