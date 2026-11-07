import { apply, ApplyResult, TRADE_ID_NAMESPACE, uuidv5 } from '../../src/matching/engine';
import {
  acceptedAt,
  emptyBook,
  lot,
  multiFill,
  samePrice,
  selfCross,
  submit,
} from '../helpers/matching-fixtures';

describe('matching commands', () => {
  it('fills at maker prices in price-time order and retains the partial maker', () => {
    const { book, command } = multiFill;
    const result = apply(book, command);

    expect(result.trades).toEqual([
      {
        tradeId: '802d8869-5d8b-5111-a562-c48ebe230ba1',
        instrument: 'ABC',
        buyOrderId: 'order-4',
        sellOrderId: 'order-1',
        price: 10_000n,
        quantity: 50_000_000n,
        executedAt: acceptedAt,
      },
      {
        tradeId: 'afad13b4-bd02-5243-9e8a-6bfe21c6d525',
        instrument: 'ABC',
        buyOrderId: 'order-4',
        sellOrderId: 'order-2',
        price: 10_000n,
        quantity: 70_000_000n,
        executedAt: acceptedAt,
      },
      {
        tradeId: 'edde641e-1b00-5b7b-9710-755f299cbfe0',
        instrument: 'ABC',
        buyOrderId: 'order-4',
        sellOrderId: 'order-3',
        price: 10_100n,
        quantity: 80_000_000n,
        executedAt: acceptedAt,
      },
    ]);
    expect(result.book).toEqual({
      bids: [],
      asks: [{ ...book.asks[2], remaining: 20_000_000n }],
    });
    expect(result.orderChanges).toMatchObject([
      { id: 'order-1', remaining: 0n, status: 'filled' },
      { id: 'order-2', remaining: 0n, status: 'filled' },
      { id: 'order-3', remaining: 20_000_000n, status: 'partially_filled' },
      { id: 'order-4', remaining: 0n, status: 'filled' },
    ]);
    expect(result.levelChanges).toEqual([
      { side: 'sell', price: 10_000n, quantity: 0n, orders: 0 },
      { side: 'sell', price: 10_100n, quantity: 20_000_000n, orders: 1 },
    ]);
  });

  it('uses the earlier sequence at the same price even when the input is reversed', () => {
    const { book, command } = samePrice;
    const result = apply(book, command);
    expect(result.trades).toMatchObject([{ sellOrderId: 'order-3' }]);
    expect(result.book).toEqual({ bids: [], asks: [book.asks[0]] });
    expect(result.levelChanges).toEqual([
      { side: 'sell', price: 10_000n, quantity: lot, orders: 1 },
    ]);
  });

  function assertSelfCross(result: ApplyResult) {
    expect(result.trades).toMatchObject([
      { buyOrderId: 'order-3', sellOrderId: 'order-2', price: 9_900n, quantity: lot },
    ]);
    expect(result.orderChanges).toContainEqual({
      ...selfCross.command.order,
      prioritySeq: 3n,
      remaining: lot,
      status: 'cancelled',
      cancelReason: 'self_trade_prevented',
    });
    expect(result.closed).toEqual([
      { orderId: 'order-3', reason: 'self_trade_prevented', releasedAmount: 10_000n * lot },
    ]);
    expect(result.book).toEqual({ bids: [], asks: [selfCross.book.asks[0]] });
    expect(result.levelChanges).toEqual([{ side: 'sell', price: 9_900n, quantity: 0n, orders: 0 }]);
  }

  it('cancels the incoming remainder after earlier fills at better prices', () => {
    assertSelfCross(apply(selfCross.book, selfCross.command));
  });

  it('detects a no-op self-trade policy with the same assertions', () => {
    const result = apply(selfCross.book, selfCross.command, { stp: () => false });
    expect(result.trades.map(({ sellOrderId }) => sellOrderId)).toEqual(['order-2', 'order-1']);
    expect(() => assertSelfCross(result)).toThrow();
  });

  it('rests on an empty book and publishes the absolute level', () => {
    const command = submit(1n, 'buy', 10_000n, lot, 'buyer');
    const result = apply(emptyBook, command);
    expect(result.book.bids).toEqual([{ ...command.order, prioritySeq: 1n }]);
    expect(result.orderChanges).toMatchObject([{ status: 'open' }]);
    expect(result.levelChanges).toEqual([
      { side: 'buy', price: 10_000n, quantity: lot, orders: 1 },
    ]);
    expect(result.trades).toEqual([]);
  });

  it('cancels a partial order and releases only the unfilled quantity', () => {
    const { book, command } = multiFill;
    const partial = apply(book, command).book;
    const cancelled = apply(partial, { type: 'cancel', orderId: 'order-3' });
    expect(cancelled.book).toEqual(emptyBook);
    expect(cancelled.outcome).toBe('applied');
    expect(cancelled.orderChanges).toMatchObject([
      {
        id: 'order-3',
        quantity: lot,
        remaining: 20_000_000n,
        status: 'cancelled',
        cancelReason: 'user',
      },
    ]);
    expect(cancelled.closed).toEqual([
      { orderId: 'order-3', reason: 'user', releasedAmount: 20_000_000n },
    ]);
    expect(cancelled.levelChanges).toEqual([
      { side: 'sell', price: 10_100n, quantity: 0n, orders: 0 },
    ]);
  });

  it.each([
    [undefined, 'not_found'],
    ['filled', 'already_filled'],
    ['cancelled', 'already_cancelled'],
  ] as const)(
    'returns an empty delta for a missing active order (terminal status %s)',
    (terminalStatus, outcome) => {
      expect(apply(emptyBook, { type: 'cancel', orderId: 'absent', terminalStatus })).toEqual({
        book: emptyBook,
        outcome,
        orderChanges: [],
        trades: [],
        levelChanges: [],
        closed: [],
      });
    },
  );

  it('leaves the input untouched and produces an identical replay including trade IDs', () => {
    const book = Object.freeze({
      bids: Object.freeze([]),
      asks: Object.freeze(multiFill.book.asks.map((order) => Object.freeze({ ...order }))),
    });
    const command = Object.freeze({
      ...multiFill.command,
      order: Object.freeze({ ...multiFill.command.order }),
    });
    expect(apply(book, command)).toEqual(apply(book, command));
    expect(book).toEqual(multiFill.book);
    expect(command).toEqual(multiFill.command);
  });
});

describe('trade UUIDs', () => {
  it('matches the DNS test vector and generates a stable version 5 ID for each fill', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );

    const id = uuidv5(TRADE_ID_NAMESPACE, 'ABC:4:0');
    expect(id).toBe(uuidv5(TRADE_ID_NAMESPACE, 'ABC:4:0'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
