import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Book, compareOrders } from '../matching/book';
import { Order } from '../orders/entities/order.entity';
import { bookOrder } from './command';

export function counters(book: Book) {
  return {
    bidCount: String(book.bids.length), askCount: String(book.asks.length),
    bidLots: book.bids.reduce((sum, order) => sum + order.remaining, 0n).toString(),
    askLots: book.asks.reduce((sum, order) => sum + order.remaining, 0n).toString(),
    count: String(book.bids.length + book.asks.length),
    quantity: [...book.bids, ...book.asks].reduce((sum, order) => sum + order.remaining, 0n).toString(),
  };
}

@Injectable()
export class BookLoader {
  private readonly logger = new Logger(BookLoader.name);

  async load(db: EntityManager, instrument: string): Promise<{ book: Book; seq: string; halted: boolean }> {
    const [state] = await db.query('SELECT * FROM instrument_state WHERE instrument=$1 FOR UPDATE', [instrument]);
    const rows = await db.getRepository(Order).find({ where: { instrument, status: In(['open', 'partially_filled']) } });
    const orders = rows.map(bookOrder);
    const book = {
      bids: orders.filter(({ side }) => side === 'buy').sort(compareOrders),
      asks: orders.filter(({ side }) => side === 'sell').sort(compareOrders),
    };
    const actual = counters(book);
    const crossed = book.bids.length > 0 && book.asks.length > 0 && book.bids[0].price >= book.asks[0].price;
    if (actual.count !== state.resting_count || actual.quantity !== state.resting_quantity
      || actual.bidCount !== state.resting_bid_count || actual.askCount !== state.resting_ask_count
      || actual.bidLots !== state.resting_bid_lots || actual.askLots !== state.resting_ask_lots || crossed) {
      await db.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [instrument]);
      this.logger.error({ alert: 'engine_recovery_mismatch', instrument });
      state.status = 'halted';
    }
    await db.query('UPDATE instrument_state SET recovered_at=now() WHERE instrument=$1', [instrument]);
    return { book, seq: state.last_applied_seq, halted: state.status === 'halted' };
  }
}
