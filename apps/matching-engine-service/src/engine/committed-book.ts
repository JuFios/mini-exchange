import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class CommittedBook {
  constructor(private readonly source: DataSource) {}
  async read(instrument: string, limit = 50) {
    return this.source.transaction('REPEATABLE READ', async (db) => {
      await db.query('SET TRANSACTION READ ONLY');
      const [state] = await db.query(
        'SELECT last_applied_seq,legacy_verified FROM instrument_state WHERE instrument=$1',
        [instrument],
      );
      if (!state.legacy_verified)
        throw new ServiceUnavailableException({ code: 'INSTRUMENT_HALTED' });
      const levels = await db.query(
        `SELECT side,price,sum(remaining_quantity)::text AS quantity,count(*)::int AS orders
        FROM orders WHERE instrument=$1 AND status IN ('open','partially_filled') GROUP BY side,price`,
        [instrument],
      );
      const rows = (side: string) =>
        levels
          .filter((row: { side: string }) => row.side === side)
          .sort(
            (a: { price: string }, b: { price: string }) =>
              (side === 'buy' ? -1 : 1) * (Number(a.price) - Number(b.price)),
          )
          .slice(0, limit)
          .map(
            ({ price, quantity, orders }: { price: string; quantity: string; orders: number }) => ({
              price,
              quantity,
              orders,
            }),
          );
      return { instrument, seq: state.last_applied_seq, bids: rows('buy'), asks: rows('sell') };
    });
  }
}
