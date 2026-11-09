import { EntityManager } from 'typeorm';
import type { Asset } from '../ledger/amount';

export interface ReservationRecord {
  reservation_id: string;
  user_id: string;
  asset: Asset;
  instrument: Asset | null;
  limit_price_ticks: string | null;
  remaining: string;
  status: 'active' | 'closed' | 'rejected' | 'released_tombstone';
  request_hash: string | null;
  result: { status: 'accepted' | 'rejected' } | null;
}

export function lockReservations(db: EntityManager, ids: string[]): Promise<ReservationRecord[]> {
  return db.query(
    `SELECT * FROM reservations WHERE reservation_id = ANY($1::uuid[])
     ORDER BY reservation_id FOR UPDATE`,
    [ids],
  );
}

export async function consumeReservation(db: EntityManager, id: string, amount: bigint) {
  const [, updated] = await db.query(
    `UPDATE reservations SET remaining=remaining-$2,
       status=CASE WHEN remaining=$2 THEN 'closed' ELSE 'active' END
     WHERE reservation_id=$1 AND status='active' AND remaining >= $2`,
    [id, amount.toString()],
  );
  if (updated !== 1) throw new Error('Reserved amount changed while locked');
}
