import { Injectable } from '@nestjs/common';
import { Order } from './entities/order.entity';
import { BookSnapshot } from './order-book.types';

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

  depth(instrument: string): BookSnapshot {
    return this.snapshot(instrument);
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
