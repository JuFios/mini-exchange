import { Injectable } from '@nestjs/common';
import { Book, BookOrder, changedLevels } from '../matching/book';
import { apply, ApplyResult, Command } from '../matching/engine';

export type WorkerResult = Omit<ApplyResult, 'outcome' | 'orderChanges' | 'closed'> & {
  outcome: ApplyResult['outcome'] | 'rejected_internal';
  orderChanges: (BookOrder & {
    status: ApplyResult['orderChanges'][number]['status'];
    cancelReason?: 'user' | 'self_trade_prevented' | 'rejected';
  })[];
  closed: {
    orderId: string;
    reason: ApplyResult['closed'][number]['reason'] | 'rejected';
    releasedAmount: bigint;
  }[];
};

@Injectable()
export class CommandApplier {
  apply(book: Book, command: Command): WorkerResult {
    return apply(book, command);
  }
}

export function toRejectedInternal(book: Book, order: BookOrder, terminal = false): WorkerResult {
  const next = {
    bids: book.bids.filter(({ id }) => id !== order.id),
    asks: book.asks.filter(({ id }) => id !== order.id),
  };
  const removed = [...book.bids, ...book.asks].filter(({ id }) => id === order.id);
  return {
    book: next,
    outcome: 'rejected_internal',
    trades: [],
    levelChanges: changedLevels(next, removed),
    orderChanges: terminal ? [] : [{ ...order, status: 'cancelled', cancelReason: 'rejected' }],
    closed: terminal
      ? []
      : [
          {
            orderId: order.id,
            reason: 'rejected',
            releasedAmount: order.side === 'buy' ? order.price * order.remaining : order.remaining,
          },
        ],
  };
}
