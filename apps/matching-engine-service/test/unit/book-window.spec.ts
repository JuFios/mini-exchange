import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { Book, BookOrder, LevelChange, Side } from '../../src/matching/book';
import { apply, Command } from '../../src/matching/engine';
import { emptyBook, lot, resting, submit } from '../helpers/matching-fixtures';

const DEPTH = 50;

type Level = { quantity: bigint; orders: number };
type Window = Record<Side, [bigint, Level][]>;

const better = (side: Side) => (a: bigint, b: bigint) =>
  a === b ? 0 : a < b === (side === 'sell') ? -1 : 1;

function windowOf(book: Book): Window {
  const sides = { buy: book.bids, sell: book.asks };
  const result = { buy: [], sell: [] } as Window;
  for (const side of ['buy', 'sell'] as const) {
    const levels = new Map<bigint, Level>();
    for (const { price, remaining } of sides[side]) {
      const level = levels.get(price) ?? { quantity: 0n, orders: 0 };
      levels.set(price, { quantity: level.quantity + remaining, orders: level.orders + 1 });
    }
    result[side] = [...levels].sort(([a], [b]) => better(side)(a, b)).slice(0, DEPTH);
  }
  return result;
}

/** Клієнт: застосовує delta до свого вікна й лишає `DEPTH` найкращих рівнів сторони. */
function applyChanges(window: Window, changes: readonly LevelChange[]): Window {
  const next = { buy: new Map(window.buy), sell: new Map(window.sell) };
  for (const { side, price, quantity, orders } of changes) {
    if (quantity === 0n) next[side].delete(price);
    else next[side].set(price, { quantity, orders });
  }
  return {
    buy: [...next.buy].sort(([a], [b]) => better('buy')(a, b)).slice(0, DEPTH),
    sell: [...next.sell].sort(([a], [b]) => better('sell')(a, b)).slice(0, DEPTH),
  };
}

function deepBook(side: Side, levels: number): Book {
  const orders: BookOrder[] = Array.from({ length: levels }, (_, index) => {
    const price = side === 'sell' ? 10_000n + BigInt(index) * 100n : 20_000n - BigInt(index) * 100n;
    return resting(submit(BigInt(index + 1), side, price, lot, 'maker'));
  });
  return side === 'sell' ? { bids: [], asks: orders } : { bids: orders, asks: [] };
}

describe('level changes keep a depth-limited client book exact', () => {
  it.each([
    ['sell', 'asks'],
    ['buy', 'bids'],
  ] as const)(
    'adds the level that enters the top %s window when the best level is cancelled',
    (side, key) => {
      const book = deepBook(side, DEPTH + 1);
      const best = book[key][0];
      const entering = book[key][DEPTH];

      const result = apply(book, { type: 'cancel', orderId: best.id });

      expect(result.levelChanges).toEqual([
        { side, price: best.price, quantity: 0n, orders: 0 },
        { side, price: entering.price, quantity: lot, orders: 1 },
      ]);
    },
  );

  it('adds the level that enters the window when a taker consumes the best level', () => {
    const book = deepBook('sell', DEPTH + 1);
    const result = apply(book, submit(100n, 'buy', book.asks[0].price, lot, 'taker'));

    expect(result.levelChanges).toEqual([
      { side: 'sell', price: book.asks[0].price, quantity: 0n, orders: 0 },
      { side: 'sell', price: book.asks[DEPTH].price, quantity: lot, orders: 1 },
    ]);
  });

  it('does not report levels beyond the window when nothing enters it', () => {
    const book = deepBook('sell', DEPTH + 5);
    const result = apply(book, { type: 'cancel', orderId: book.asks[DEPTH + 2].id });

    expect(result.levelChanges).toEqual([
      { side: 'sell', price: book.asks[DEPTH + 2].price, quantity: 0n, orders: 0 },
    ]);
  });

  it('equals the window of the real book after any sequence of commands', () => {
    const actions = fc.oneof(
      {
        weight: 8,
        arbitrary: fc.record({
          type: fc.constant('submit' as const),
          side: fc.constantFrom('buy' as const, 'sell' as const),
          slot: fc.nat(159),
          quantity: fc.bigInt({ min: 1n, max: 5n }),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          type: fc.constant('cross' as const),
          side: fc.constantFrom('buy' as const, 'sell' as const),
          quantity: fc.bigInt({ min: 1n, max: 20n }),
        }),
      },
      {
        weight: 2,
        arbitrary: fc.record({ type: fc.constant('cancel' as const), target: fc.nat(299) }),
      },
    );

    fc.assert(
      fc.property(fc.array(actions, { minLength: 300, maxLength: 300 }), (sequence) => {
        let book: Book = emptyBook;
        let client = windowOf(book);
        const closed = new Map<string, 'filled' | 'cancelled'>();

        for (const [index, action] of sequence.entries()) {
          const seq = BigInt(index + 1);
          let command: Command;
          if (action.type === 'submit') {
            // Спільні діапазони цін не перетинаються, тож глибокі книги з'являються без угод.
            const price = (action.side === 'buy' ? 1_000n : 2_000n) + BigInt(action.slot);
            command = submit(seq, action.side, price, action.quantity, 'maker');
          } else if (action.type === 'cross') {
            const price = action.side === 'buy' ? 2_159n : 1_000n;
            command = submit(seq, action.side, price, action.quantity, 'taker');
          } else {
            const orderId = `order-${action.target + 1}`;
            command = { type: 'cancel', orderId, terminalStatus: closed.get(orderId) };
          }

          const result = apply(book, command);
          for (const change of result.orderChanges)
            if (change.status === 'filled' || change.status === 'cancelled')
              closed.set(change.id, change.status);
          book = result.book;
          client = applyChanges(client, result.levelChanges);
          assert.deepEqual(client, windowOf(book), `window diverged after command ${index + 1}`);
        }
      }),
      { numRuns: 200 },
    );
  });
});
