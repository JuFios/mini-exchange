import { randomUUID } from 'node:crypto';
import { describeTrade } from '../../src/trades/trades.service';
import {
  compareStreams,
  EngineTrade,
  expectedPostings,
  LedgerTrade,
} from '../../src/reconciliation/trade-comparison';

const now = Date.parse('2026-01-01T12:00:00.000Z');
const context = (failed: string[] = []) => ({
  isFailed: async (tradeId: string) => failed.includes(tradeId),
  now,
  graceMs: 30_000,
  limit: 100,
});

function engineTrade(executedAt: string, changes: Partial<EngineTrade> = {}): EngineTrade {
  return {
    tradeId: randomUUID(),
    instrument: 'ABC',
    executedAt,
    price: '100.00',
    quantity: '0.50000000',
    buyOrderId: randomUUID(),
    sellOrderId: randomUUID(),
    buyerUserId: randomUUID(),
    sellerUserId: randomUUID(),
    buyLimitPrice: '101.00',
    baseAsset: 'ABC',
    quoteAsset: 'USD',
    ...changes,
  };
}

const settled = (trade: EngineTrade, change?: (ledger: LedgerTrade) => void): LedgerTrade => {
  const ledger: LedgerTrade = {
    tradeId: trade.tradeId,
    instrument: trade.instrument,
    executedAt: trade.executedAt,
    payloadHash: describeTrade(trade).hash,
    postings: expectedPostings(trade),
  };
  change?.(ledger);
  return ledger;
};

async function* of<T>(items: T[]) {
  yield* items;
}
const compare = (engine: EngineTrade[], ledger: LedgerTrade[], failed: string[] = []) =>
  compareStreams(
    of(
      [...engine].sort(
        (a, b) => a.executedAt.localeCompare(b.executedAt) || a.tradeId.localeCompare(b.tradeId),
      ),
    ),
    of(
      [...ledger].sort(
        (a, b) => a.executedAt.localeCompare(b.executedAt) || a.tradeId.localeCompare(b.tradeId),
      ),
    ),
    context(failed),
  );

it('accepts matching books and totals both sides', async () => {
  const trades = [engineTrade('2026-01-01T10:00:00.000Z'), engineTrade('2026-01-01T10:00:01.000Z')];
  const result = await compare(
    trades,
    trades.map((trade) => settled(trade)),
  );
  expect(result.discrepancies).toEqual([]);
  expect(result.matched).toBe(2);
  expect(result.engine.get('ABC')).toEqual({
    count: 2,
    quantity: 100000000n,
    quote: 1_000_000_000_000n,
  });
  expect(result.ledger.get('ABC')).toEqual(result.engine.get('ABC'));
});

it('reports every discrepancy class and distinguishes pending from missing', async () => {
  const [ok, missing, pending, failed, mismatch, duplicate, conflict] = [
    engineTrade('2026-01-01T09:00:00.000Z'),
    engineTrade('2026-01-01T09:00:01.000Z'),
    engineTrade('2026-01-01T11:59:50.000Z'),
    engineTrade('2026-01-01T09:00:02.000Z'),
    engineTrade('2026-01-01T09:00:03.000Z'),
    engineTrade('2026-01-01T09:00:04.000Z'),
    engineTrade('2026-01-01T09:00:05.000Z'),
  ];
  const orphan = engineTrade('2026-01-01T09:00:06.000Z');
  const result = await compare(
    [ok, missing, pending, failed, mismatch, duplicate, conflict],
    [
      settled(ok),
      settled(mismatch, (ledger) => (ledger.postings[3].amount = '1')),
      settled(duplicate, (ledger) => (ledger.postings = [...ledger.postings, ...ledger.postings])),
      settled(conflict, (ledger) => (ledger.payloadHash = 'f'.repeat(64))),
      settled(orphan),
    ],
    [failed.tradeId],
  );
  const byId = new Map(result.discrepancies.map((d) => [d.tradeId, d.type]));
  expect(Object.fromEntries(byId)).toEqual({
    [missing.tradeId]: 'missing',
    [pending.tradeId]: 'pending',
    [failed.tradeId]: 'failed',
    [mismatch.tradeId]: 'amount_mismatch',
    [duplicate.tradeId]: 'duplicate',
    [conflict.tradeId]: 'payload_conflict',
    [orphan.tradeId]: 'orphan',
  });
  expect(result.matched).toBe(1);
});

it('lists a trade whose time differs on both sides instead of silently matching it', async () => {
  const trade = engineTrade('2026-01-01T09:00:00.000Z');
  const result = await compare(
    [trade],
    [{ ...settled(trade), executedAt: '2026-01-01T09:00:00.001Z' }],
  );
  expect(result.discrepancies.map(({ type }) => type).sort()).toEqual(['missing', 'orphan']);
});

it('keeps exact counts when the list of discrepancies is capped', async () => {
  const trades = Array.from({ length: 5 }, (_, i) => engineTrade(`2026-01-01T09:00:0${i}.000Z`));
  const result = await compareStreams(of(trades), of([]), { ...context(), limit: 2 });
  expect(result.discrepancies).toHaveLength(2);
  expect(result.counts.missing).toBe(5);
});

it('names the engine trade that cannot be compared instead of reporting a partial result', async () => {
  const bad = engineTrade('2026-01-01T09:00:00.000Z', { price: 'x' });
  await expect(compare([bad], [])).rejects.toThrow(bad.tradeId);
});
