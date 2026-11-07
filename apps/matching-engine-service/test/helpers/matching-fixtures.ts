import type { Book, BookOrder, Side } from '../../src/matching/book';
import type { SubmitCommand } from '../../src/matching/engine';

export const emptyBook: Book = Object.freeze({
  bids: Object.freeze([]),
  asks: Object.freeze([]),
});
export const acceptedAt = '2026-01-01T00:00:00.000Z';
export const lot = 100_000_000n;

export function submit(
  seq: bigint,
  side: Side,
  price: bigint,
  quantity: bigint,
  ownerId: string,
): SubmitCommand {
  return {
    type: 'submit',
    instrument: 'ABC',
    seq,
    acceptedAt,
    order: { id: `order-${seq}`, ownerId, side, price, quantity, remaining: quantity },
  };
}

export function resting(command: SubmitCommand): BookOrder {
  return { ...command.order, prioritySeq: command.seq };
}

export const multiFill = {
  book: {
    bids: [],
    asks: [
      resting(submit(1n, 'sell', 10_000n, 50_000_000n, 'seller')),
      resting(submit(2n, 'sell', 10_000n, 70_000_000n, 'seller')),
      resting(submit(3n, 'sell', 10_100n, lot, 'seller')),
    ],
  },
  command: submit(4n, 'buy', 10_100n, 2n * lot, 'buyer'),
};

export const samePrice = {
  book: {
    bids: [],
    asks: [
      resting(submit(7n, 'sell', 10_000n, lot, 'seller')),
      resting(submit(3n, 'sell', 10_000n, lot, 'seller')),
    ],
  },
  command: submit(8n, 'buy', 10_000n, lot, 'buyer'),
};

export const selfCross = {
  book: {
    bids: [],
    asks: [
      resting(submit(1n, 'sell', 10_000n, lot, 'X')),
      resting(submit(2n, 'sell', 9_900n, lot, 'Y')),
    ],
  },
  command: submit(3n, 'buy', 10_000n, 2n * lot, 'X'),
};
