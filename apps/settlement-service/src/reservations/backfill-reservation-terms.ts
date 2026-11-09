import { DataSource } from 'typeorm';
import { requestHash } from '../ledger/ledger-writer';

const BATCH_SIZE = 500;

interface OrderTerms {
  reservation_id: string;
  user_id: string;
  asset: string;
  instrument: string;
  amount: string;
  limit_price_ticks: string;
}

async function unbound(
  source: DataSource,
  after: string | null,
): Promise<{ reservation_id: string }[]> {
  return source.query(
    `SELECT reservation_id FROM reservations
     WHERE status='active' AND instrument IS NULL AND ($1::uuid IS NULL OR reservation_id > $1)
     ORDER BY reservation_id LIMIT $2`,
    [after, BATCH_SIZE],
  );
}

export async function backfillReservationTerms(
  source: DataSource,
  connectEngine: () => Promise<DataSource>,
): Promise<void> {
  let batch = await unbound(source, null);
  if (!batch.length) return;
  const engine = await connectEngine();
  try {
    while (batch.length) {
      const ids = batch.map(({ reservation_id }) => reservation_id);
      const terms: OrderTerms[] = await engine.query(
        `SELECT o.id AS reservation_id,o.owner_id AS user_id,o.instrument,
           CASE o.side WHEN 'buy' THEN i.quote_asset ELSE i.base_asset END AS asset,
           (o.quantity * 100000000 * CASE o.side WHEN 'buy' THEN o.price * 100 ELSE 1 END)::numeric(38,0) AS amount,
           (o.price * 100)::bigint AS limit_price_ticks
         FROM orders o
         JOIN order_requests r ON r.order_id=o.id AND r.status='accepted'
         JOIN instruments i ON i.symbol=o.instrument
         WHERE o.id=ANY($1::uuid[])`,
        [ids],
      );
      if (terms.length) {
        const values = terms.map((row) => {
          const wallet = { userId: row.user_id, asset: row.asset, amount: row.amount };
          return {
            ...row,
            legacy_hash: requestHash(wallet),
            request_hash: requestHash({
              ...wallet,
              instrument: row.instrument,
              limit: row.limit_price_ticks,
            }),
          };
        });
        await source.query(
          `UPDATE reservations r SET instrument=t.instrument,limit_price_ticks=t.limit_price_ticks,
             request_hash=t.request_hash
           FROM jsonb_to_recordset($1::jsonb) AS t(
             reservation_id uuid,user_id uuid,asset text,instrument text,amount numeric,
             limit_price_ticks bigint,legacy_hash text,request_hash text)
           WHERE r.reservation_id=t.reservation_id AND r.status='active' AND r.instrument IS NULL
             AND r.user_id=t.user_id AND r.asset=t.asset AND r.amount=t.amount AND r.request_hash IN (t.legacy_hash,t.request_hash)`,
          [JSON.stringify(values)],
        );
        const [mismatch] = await source.query(
          `SELECT reservation_id FROM reservations
           WHERE reservation_id=ANY($1::uuid[]) AND status='active' AND instrument IS NULL LIMIT 1`,
          [terms.map(({ reservation_id }) => reservation_id)],
        );
        if (mismatch)
          throw new Error(
            `Legacy reserve does not match accepted order: ${mismatch.reservation_id}`,
          );
      }
      batch = await unbound(source, ids[ids.length - 1]);
    }
  } finally {
    await engine.destroy();
  }
}
