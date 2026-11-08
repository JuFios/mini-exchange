import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { Book, compareOrders } from '../matching/book';
import { Order } from '../orders/entities/order.entity';
import { bookOrder } from './command';

export function counters(book: Book) {
  return {
    bidCount: String(book.bids.length),
    askCount: String(book.asks.length),
    bidLots: book.bids.reduce((sum, order) => sum + order.remaining, 0n).toString(),
    askLots: book.asks.reduce((sum, order) => sum + order.remaining, 0n).toString(),
    count: String(book.bids.length + book.asks.length),
    quantity: [...book.bids, ...book.asks]
      .reduce((sum, order) => sum + order.remaining, 0n)
      .toString(),
  };
}

@Injectable()
export class BookLoader {
  recoveryMismatches = 0;
  private readonly logger = new Logger(BookLoader.name);

  async load(
    db: EntityManager,
    instrument: string,
    resume = false,
  ): Promise<{ book: Book; seq: string; halted: boolean; quarantined?: boolean }> {
    const [state] = await db.query(
      'SELECT * FROM instrument_state WHERE instrument=$1 FOR UPDATE',
      [instrument],
    );
    if (state.legacy_verified !== true) {
      await db.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [
        instrument,
      ]);
      this.logger.error({ alert: 'engine_legacy_state_unverified', instrument });
      return {
        book: { bids: [], asks: [] },
        seq: state.last_applied_seq,
        halted: true,
        quarantined: true,
      };
    }
    // Читання й сортування великої книги довше за 5 с і 2 с простою сесії за замовчуванням.
    // Послаблення діє лише в цій TX; takeover чекає рядок не довше за lock_timeout.
    await db.query("SET LOCAL statement_timeout='10s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    const rows = await db
      .getRepository(Order)
      .find({ where: { instrument, status: In(['open', 'partially_filled']) } });
    const orders = rows.map(bookOrder);
    const book = {
      bids: orders.filter(({ side }) => side === 'buy').sort(compareOrders),
      asks: orders.filter(({ side }) => side === 'sell').sort(compareOrders),
    };
    let journalValid = true;
    if (resume) {
      // Один MVCC snapshot узгоджує лічильник intake з журналом без зворотного порядку блокувань.
      const [journal] = await db.query(
        `SELECT i.next_seq >= $2::bigint
          AND count(c.seq) = i.next_seq
          AND COALESCE(bool_and(c.seq <= i.next_seq
            AND ((c.seq <= $2::bigint) = (c.applied_at IS NOT NULL))), true) AS valid
        FROM instruments i LEFT JOIN order_commands c ON c.instrument=i.symbol
        WHERE i.symbol=$1 GROUP BY i.next_seq`,
        [instrument, state.last_applied_seq],
      );
      journalValid = journal?.valid === true;
    }
    const actual = counters(book);
    const crossed =
      book.bids.length > 0 && book.asks.length > 0 && book.bids[0].price >= book.asks[0].price;
    if (
      actual.count !== state.resting_count ||
      actual.quantity !== state.resting_quantity ||
      actual.bidCount !== state.resting_bid_count ||
      actual.askCount !== state.resting_ask_count ||
      actual.bidLots !== state.resting_bid_lots ||
      actual.askLots !== state.resting_ask_lots ||
      crossed ||
      !journalValid
    ) {
      await db.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [
        instrument,
      ]);
      this.recoveryMismatches++;
      this.logger.error({ alert: 'engine_recovery_mismatch', instrument });
      state.status = 'halted';
    } else if (resume) {
      await db.query("UPDATE instrument_state SET status='active' WHERE instrument=$1", [
        instrument,
      ]);
      state.status = 'active';
    }
    await db.query(
      'UPDATE instrument_state SET recovered_at=clock_timestamp() WHERE instrument=$1',
      [instrument],
    );
    return { book, seq: state.last_applied_seq, halted: state.status === 'halted' };
  }
}
