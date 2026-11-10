import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { TerminalOrder } from '../../src/reconciliation/engine-orders.client';
import {
  ActiveReservation,
  scanStuckReservations,
  stuckReservations,
} from '../../src/reconciliation/stuck-reservations';

const now = Date.parse('2026-01-01T12:00:00.000Z');
const graceMs = 30_000;
const ago = (ms: number) => new Date(now - ms).toISOString();

const reservation = (changes: Partial<ActiveReservation> = {}): ActiveReservation => ({
  reservation_id: randomUUID(),
  user_id: randomUUID(),
  asset: 'USD',
  instrument: 'ABC',
  remaining: '505000000000',
  ...changes,
});
const terminal = (
  { reservation_id }: ActiveReservation,
  closedAt: string,
  status: TerminalOrder['status'] = 'cancelled',
): TerminalOrder => ({ orderId: reservation_id, instrument: 'ABC', status, closedAt });

describe('stuckReservations', () => {
  it('reports an active reservation whose order closed before the grace period', () => {
    const stuck = reservation();
    const [found, ...rest] = stuckReservations([stuck], [terminal(stuck, ago(60_000))], {
      now,
      graceMs,
    });
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      type: 'stuck_reservation',
      tradeId: null,
      instrument: 'ABC',
      executedAt: null,
      expected: { reservationId: stuck.reservation_id, remaining: '0' },
      actual: {
        reservationId: stuck.reservation_id,
        userId: stuck.user_id,
        asset: 'USD',
        remaining: '505000000000',
        orderStatus: 'cancelled',
        closedAt: ago(60_000),
      },
    });
  });

  it('tolerates a close that is still within the grace period and treats the bound as stuck', () => {
    const fresh = reservation();
    const edge = reservation();
    const found = stuckReservations(
      [fresh, edge],
      [terminal(fresh, ago(graceMs - 1)), terminal(edge, ago(graceMs), 'filled')],
      { now, graceMs },
    );
    expect(found.map(({ actual }) => (actual as { reservationId: string }).reservationId)).toEqual([
      edge.reservation_id,
    ]);
  });

  it('ignores orders without an active reservation and matches ids regardless of case', () => {
    const upper = reservation();
    const unrelated = terminal(reservation(), ago(60_000));
    const found = stuckReservations(
      [upper],
      [unrelated, { ...terminal(upper, ago(60_000)), orderId: upper.reservation_id.toUpperCase() }],
      { now, graceMs },
    );
    expect(found).toHaveLength(1);
  });
});

describe('scanStuckReservations', () => {
  /** Імітує keyset-сторінки reservations: повертає записи після курсору, не більше LIMIT. */
  function database(all: ActiveReservation[]) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        const [after, instrument] = params as [string, string | undefined];
        return all
          .filter((r) => r.reservation_id > after && (!instrument || r.instrument === instrument))
          .slice(0, 1000);
      },
    };
    return { db: db as unknown as EntityManager, queries };
  }
  const sorted = (count: number) =>
    Array.from({ length: count }, () => reservation()).sort((a, b) =>
      a.reservation_id.localeCompare(b.reservation_id),
    );

  it('pages through all reservations, counts every stuck one and caps the returned list', async () => {
    const all = sorted(2300);
    const closed = new Set([all[0], all[999], all[1000], all[2299]].map((r) => r.reservation_id));
    const asked: number[] = [];
    const engine = {
      terminal: async (ids: string[]) => {
        asked.push(ids.length);
        return all
          .filter((r) => ids.includes(r.reservation_id) && closed.has(r.reservation_id))
          .map((r) => terminal(r, ago(60_000)));
      },
    };
    const { db, queries } = database(all);

    const result = await scanStuckReservations(db, engine, { now, graceMs, limit: 3 });

    expect(asked).toEqual([1000, 1000, 300]);
    expect(queries.map(({ params }) => params[0])).toEqual([
      '00000000-0000-0000-0000-000000000000',
      all[999].reservation_id,
      all[1999].reservation_id,
    ]);
    expect(result.count).toBe(4);
    expect(result.found).toHaveLength(3);
  });

  it('stops after a short page and skips the engine when nothing is active', async () => {
    const calls: string[][] = [];
    const engine = {
      terminal: async (ids: string[]) => {
        calls.push(ids);
        return [];
      },
    };
    expect(
      await scanStuckReservations(database([]).db, engine, { now, graceMs, limit: 10 }),
    ).toEqual({
      count: 0,
      found: [],
    });
    const one = sorted(1);
    const { db, queries } = database(one);
    await scanStuckReservations(db, engine, { now, graceMs, limit: 10 });
    expect(calls).toEqual([[one[0].reservation_id]]);
    expect(queries).toHaveLength(1);
  });

  it('limits the scan to one instrument when asked', async () => {
    const all = sorted(4).map((r, i) => ({ ...r, instrument: i % 2 ? 'XYZ' : 'ABC' }));
    const seen: string[][] = [];
    const engine = {
      terminal: async (ids: string[]) => {
        seen.push(ids);
        return [];
      },
    };
    const { db, queries } = database(all);
    await scanStuckReservations(db, engine, { instrument: 'XYZ', now, graceMs, limit: 10 });
    expect(queries[0].sql).toContain('instrument = $2');
    expect(seen[0].sort()).toEqual(
      all
        .filter((r) => r.instrument === 'XYZ')
        .map((r) => r.reservation_id)
        .sort(),
    );
  });
});
