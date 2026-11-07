import { Injectable } from '@nestjs/common';
import { Book, BookOrder } from '../matching/book';
import { apply, ApplyResult, Command } from '../matching/engine';

export type WorkerResult = Omit<ApplyResult, 'outcome' | 'orderChanges' | 'closed'> & {
  outcome: ApplyResult['outcome'] | 'rejected_internal';
  orderChanges: (BookOrder & { status: string; cancelReason?: string })[];
  closed: { orderId: string; reason: string; releasedAmount: bigint }[];
};

@Injectable()
export class CommandApplier {
  apply(book: Book, command: Command): WorkerResult {
    return apply(book, command);
  }
}

export function toRejectedInternal(book: Book, order: BookOrder, terminal = false): WorkerResult {
  return {
    book: { bids: book.bids.filter(({ id }) => id !== order.id), asks: book.asks.filter(({ id }) => id !== order.id) },
    outcome: 'rejected_internal', trades: [], levelChanges: [],
    orderChanges: terminal ? [] : [{ ...order, status: 'cancelled', cancelReason: 'rejected' }],
    closed: terminal ? [] : [{
      orderId: order.id, reason: 'rejected',
      releasedAmount: order.side === 'buy' ? order.price * order.remaining : order.remaining,
    }],
  };
}
