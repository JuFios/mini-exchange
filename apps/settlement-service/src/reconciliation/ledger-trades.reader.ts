import { EntityManager } from 'typeorm';
import type { Period } from './engine-trades.client';
import type { LedgerTrade, PostingRow } from './trade-comparison';

const PAGE_SIZE = 1000;

interface TradeRow {
  trade_id: string;
  instrument: string;
  executed_at: Date;
  payload_hash: string;
}

/** Угоди ledger за період, відсортовані як у engine: (executed_at, trade_id). */
export async function* ledgerTrades(
  db: EntityManager,
  period: Period,
): AsyncGenerator<LedgerTrade> {
  let cursor: { executedAt: Date; tradeId: string } | undefined;
  for (;;) {
    const params: unknown[] = [period.from, period.to];
    let filter = '';
    if (period.instrument) {
      params.push(period.instrument);
      filter += ` AND s.instrument = $${params.length}`;
    }
    if (cursor) {
      params.push(cursor.executedAt, cursor.tradeId);
      filter += ` AND (s.executed_at, s.trade_id) > ($${params.length - 1}, $${params.length})`;
    }
    const rows: TradeRow[] = await db.query(
      `SELECT s.trade_id, s.instrument, s.executed_at, s.payload_hash FROM settled_trades s
       WHERE s.executed_at >= $1 AND s.executed_at < $2${filter}
       ORDER BY s.executed_at, s.trade_id LIMIT ${PAGE_SIZE}`,
      params,
    );
    const postings = await postingsOf(
      db,
      rows.map((row) => row.trade_id),
    );
    for (const row of rows) {
      yield {
        tradeId: row.trade_id,
        instrument: row.instrument,
        executedAt: row.executed_at.toISOString(),
        payloadHash: row.payload_hash,
        postings: postings.get(row.trade_id) ?? [],
      };
    }
    if (rows.length < PAGE_SIZE) return;
    const last = rows[rows.length - 1];
    cursor = { executedAt: last.executed_at, tradeId: last.trade_id };
  }
}

async function postingsOf(db: EntityManager, ids: string[]): Promise<Map<string, PostingRow[]>> {
  const result = new Map<string, PostingRow[]>();
  if (!ids.length) return result;
  const rows: (PostingRow & { trade_id: string; user_id: string | null })[] = await db.query(
    `SELECT j.trade_id, a.user_id, a.asset, a.kind, p.direction, p.amount
     FROM journal_entries j JOIN postings p ON p.entry_id = j.id JOIN accounts a ON a.id = p.account_id
     WHERE j.trade_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const { trade_id, user_id, asset, kind, direction, amount } of rows) {
    const list = result.get(trade_id) ?? [];
    list.push({ userId: user_id, asset, kind, direction, amount });
    result.set(trade_id, list);
  }
  return result;
}
