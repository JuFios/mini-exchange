import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConcurrencyLimit } from '../database/concurrency-limit';

// Публічні читання ділять пул PG із worker. Ліміт залишає worker вільні з’єднання.
const MAX_CONCURRENT_READS = 3;
const MAX_WAITING_READS = 200;
// Клієнт, якого nginx уже відключив, не повинен залишати в черзі запит, що виконається пізніше.
const MAX_QUEUE_WAIT_MS = 2000;

interface Level {
  price: string;
  quantity: string;
  orders: number;
}

@Injectable()
export class CommittedBook extends ConcurrencyLimit {
  constructor(private readonly source: DataSource) {
    super(MAX_CONCURRENT_READS, MAX_WAITING_READS, MAX_QUEUE_WAIT_MS, 'BOOK_BUSY');
  }

  read(instrument: string, limit = 50) {
    return this.run(() =>
      this.source.transaction('REPEATABLE READ', async (db) => {
        await db.query('SET TRANSACTION READ ONLY');
        const [state] = await db.query(
          'SELECT last_applied_seq,legacy_verified FROM instrument_state WHERE instrument=$1',
          [instrument],
        );
        if (!state.legacy_verified)
          throw new ServiceUnavailableException({ code: 'INSTRUMENT_HALTED' });
        // Обидві сторони читає один snapshot; сортування й LIMIT виконує PG.
        const side = (name: 'buy' | 'sell', direction: 'DESC' | 'ASC'): Promise<Level[]> =>
          db.query(
            `SELECT price,sum(remaining_quantity)::text AS quantity,count(*)::int AS orders
            FROM orders WHERE instrument=$1 AND side=$2 AND status IN ('open','partially_filled')
            GROUP BY price ORDER BY price ${direction} LIMIT $3`,
            [instrument, name, limit],
          );
        const bids = await side('buy', 'DESC');
        const asks = await side('sell', 'ASC');
        const pick = ({ price, quantity, orders }: Level) => ({ price, quantity, orders });
        return {
          instrument,
          seq: state.last_applied_seq,
          bids: bids.map(pick),
          asks: asks.map(pick),
        };
      }),
    );
  }
}
