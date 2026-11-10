import { EntityManager } from 'typeorm';
import type { Asset } from '../ledger/amount';
import type { EngineOrdersClient, TerminalOrder } from './engine-orders.client';
import type { Discrepancy } from './trade-comparison';

const PAGE_SIZE = 1000;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface ActiveReservation {
  reservation_id: string;
  user_id: string;
  asset: Asset;
  instrument: string | null;
  remaining: string;
}

/**
 * Активний резерв при термінальній заявці означає, що `order.closed` не дійшов до ledger.
 * Свіжий перехід не рахується: подія могла бути ще в дорозі (той самий допуск, що в `pending`).
 */
export function stuckReservations(
  reservations: readonly ActiveReservation[],
  terminal: readonly TerminalOrder[],
  { now, graceMs }: { now: number; graceMs: number },
): Discrepancy[] {
  const byId = new Map(
    reservations.map((reservation) => [reservation.reservation_id, reservation]),
  );
  const found: Discrepancy[] = [];
  for (const order of terminal) {
    const reservation = byId.get(order.orderId.toLowerCase());
    if (!reservation || now - Date.parse(order.closedAt) < graceMs) continue;
    found.push({
      type: 'stuck_reservation',
      tradeId: null,
      instrument: reservation.instrument,
      executedAt: null,
      expected: { reservationId: reservation.reservation_id, remaining: '0' },
      actual: {
        reservationId: reservation.reservation_id,
        userId: reservation.user_id,
        asset: reservation.asset,
        remaining: reservation.remaining,
        orderStatus: order.status,
        closedAt: order.closedAt,
      },
    });
  }
  return found;
}

/**
 * Проходить усі активні резерви сторінками за `reservation_id` і питає engine про їхні заявки.
 * Пам'ять обмежена сторінкою; у список потрапляє не більше `limit` розбіжностей, але рахуються всі.
 */
export async function scanStuckReservations(
  db: EntityManager,
  engine: Pick<EngineOrdersClient, 'terminal'>,
  context: { instrument?: string; now: number; graceMs: number; limit: number },
): Promise<{ count: number; found: Discrepancy[] }> {
  let count = 0;
  const found: Discrepancy[] = [];
  let after = NIL_UUID;
  for (;;) {
    const params: unknown[] = [after];
    if (context.instrument) params.push(context.instrument);
    const page: ActiveReservation[] = await db.query(
      `SELECT reservation_id, user_id, asset, instrument, remaining FROM reservations
       WHERE status = 'active' AND reservation_id > $1${context.instrument ? ' AND instrument = $2' : ''}
       ORDER BY reservation_id LIMIT ${PAGE_SIZE}`,
      params,
    );
    if (page.length === 0) break;
    const stuck = stuckReservations(
      page,
      await engine.terminal(page.map(({ reservation_id }) => reservation_id)),
      context,
    );
    count += stuck.length;
    found.push(...stuck.slice(0, Math.max(0, context.limit - found.length)));
    if (page.length < PAGE_SIZE) break;
    after = page[page.length - 1].reservation_id;
  }
  return { count, found };
}
