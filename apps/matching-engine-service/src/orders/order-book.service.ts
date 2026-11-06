import { Injectable } from '@nestjs/common';
import { Order } from './entities/order.entity';
import { formatQuantity, parseQuantity } from '../matching/decimal';
import { BookDepth, BookLevel, BookSnapshot, DEFAULT_BOOK_DEPTH } from './order-book.types';

function aggregateLevels(orders: Order[], limit: number): BookLevel[] {
  const levels = new Map<string, { quantity: bigint; orders: number }>();
  // Книга вже відсортована. Після останнього рівня решту заявок можна пропустити.
  for (const order of orders) {
    const level = levels.get(order.price);
    if (level) {
      level.quantity += parseQuantity(order.remainingQuantity);
      level.orders += 1;
    } else {
      if (levels.size >= limit) break;
      levels.set(order.price, { quantity: parseQuantity(order.remainingQuantity), orders: 1 });
    }
  }
  return Array.from(levels, ([price, level]) => ({
    price,
    quantity: formatQuantity(level.quantity),
    orders: level.orders,
  }));
}

/**
 * In-memory стан order book по інструменту. У межах одного інстанса
 * matching engine кожен інструмент має рівно один набір bids/asks.
 *
 * NOTE (стартовий код): книга зберігається як звичайні масиви. Персистенція
 * в БД викликається окремо в OrdersService.
 */
@Injectable()
export class OrderBookService {
  private books = new Map<string, BookSnapshot>();

  private getOrInit(instrument: string): BookSnapshot {
    let book = this.books.get(instrument);
    if (!book) {
      book = { bids: [], asks: [] };
      this.books.set(instrument, book);
    }
    return book;
  }

  snapshot(instrument: string): BookSnapshot {
    const book = this.getOrInit(instrument);
    return {
      bids: book.bids.map((o) => ({ ...o })),
      asks: book.asks.map((o) => ({ ...o })),
    };
  }

  depth(instrument: string, limit = DEFAULT_BOOK_DEPTH): BookDepth {
    const book = this.books.get(instrument);
    if (!book) return { bids: [], asks: [] };
    return { bids: aggregateLevels(book.bids, limit), asks: aggregateLevels(book.asks, limit) };
  }

  replace(instrument: string, next: BookSnapshot): void {
    this.books.set(instrument, next);
  }

  removeOrder(instrument: string, orderId: string): boolean {
    const book = this.getOrInit(instrument);
    const bidsLen = book.bids.length;
    const asksLen = book.asks.length;
    book.bids = book.bids.filter((o) => o.id !== orderId);
    book.asks = book.asks.filter((o) => o.id !== orderId);
    return book.bids.length !== bidsLen || book.asks.length !== asksLen;
  }

  findOrder(instrument: string, orderId: string): Order | undefined {
    const book = this.getOrInit(instrument);
    return (
      book.bids.find((o) => o.id === orderId) ??
      book.asks.find((o) => o.id === orderId)
    );
  }
}
