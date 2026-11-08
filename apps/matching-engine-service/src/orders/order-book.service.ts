import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Book, BookOrder } from '../matching/book';
import { formatPrice, formatQuantity } from '../matching/decimal';
import { BookDepth, BookLevel, DEFAULT_BOOK_DEPTH } from './order-book.types';

function levels(orders: readonly BookOrder[]): BookLevel[] {
  const result = new Map<bigint, { quantity: bigint; orders: number }>();
  for (const order of orders) {
    const level = result.get(order.price) ?? { quantity: 0n, orders: 0 };
    level.quantity += order.remaining;
    level.orders++;
    result.set(order.price, level);
  }
  return [...result].map(([price, level]) => ({
    price: formatPrice(price),
    quantity: formatQuantity(level.quantity),
    orders: level.orders,
  }));
}

@Injectable()
export class OrderBookService {
  private readonly quarantined = new Set<string>();
  private readonly books = new Map<string, { seq: string; book: Book; depth?: BookDepth }>();

  // Нову книгу встановлює лише worker після успішного COMMIT або перевіреного recovery.
  // Рівні рахуються при першому читанні: на гарячому шляху команди це O(книга) без споживача.
  commit(instrument: string, book: Book, seq: string): void {
    this.quarantined.delete(instrument);
    this.books.set(instrument, { seq, book });
  }

  forget(instrument: string): void {
    this.books.delete(instrument);
    this.quarantined.delete(instrument);
  }

  quarantine(instrument: string): void {
    this.books.delete(instrument);
    this.quarantined.add(instrument);
  }

  sequence(instrument: string): string {
    return this.books.get(instrument)?.seq ?? '0';
  }

  depth(instrument: string, limit = DEFAULT_BOOK_DEPTH): BookDepth {
    if (this.quarantined.has(instrument))
      throw new ServiceUnavailableException({
        code: 'INSTRUMENT_HALTED',
        message: 'Стан книги не підтверджено',
      });
    const entry = this.books.get(instrument);
    let depth: BookDepth = { bids: [], asks: [] };
    if (entry) {
      entry.depth ??= { bids: levels(entry.book.bids), asks: levels(entry.book.asks) };
      depth = entry.depth;
    }
    return {
      bids: depth.bids.slice(0, limit).map((level) => ({ ...level })),
      asks: depth.asks.slice(0, limit).map((level) => ({ ...level })),
    };
  }
}
