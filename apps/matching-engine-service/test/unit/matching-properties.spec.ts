import assert from 'node:assert/strict';
import * as fc from 'fast-check';
import { Book } from '../../src/matching/book';
import { apply, Command, OrderChange } from '../../src/matching/engine';
import { emptyBook, submit } from '../helpers/matching-fixtures';
import { ReferenceMatcher } from '../helpers/reference-matcher';

it('agrees with the reference matcher throughout 500 sequences of 50 commands', () => {
  const actions = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        type: fc.constant('submit' as const),
        side: fc.constantFrom('buy' as const, 'sell' as const),
        price: fc.constantFrom(9_800n, 9_900n, 10_000n, 10_100n, 10_200n),
        quantity: fc.bigInt({ min: 1n, max: 10n }),
        ownerId: fc.constantFrom('A', 'B', 'C'),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ type: fc.constant('cancel' as const), target: fc.nat(50) }),
    },
  );

  fc.assert(
    fc.property(fc.array(actions, { minLength: 50, maxLength: 50 }), (sequence) => {
      let book: Book = emptyBook;
      const reference = new ReferenceMatcher();
      const filledByOrder = new Map<string, bigint>();
      const orders = new Map<string, OrderChange>();
      const tradeIds = new Set<string>();

      for (const [index, action] of sequence.entries()) {
        let command: Command;
        if (action.type === 'submit') {
          command = submit(
            BigInt(index + 1),
            action.side,
            action.price,
            action.quantity,
            action.ownerId,
          );
        } else {
          const orderId = `order-${action.target}`;
          const status = orders.get(orderId)?.status;
          const terminalStatus = status === 'filled' || status === 'cancelled' ? status : undefined;
          command = { type: 'cancel', orderId, terminalStatus };
        }

        const result = apply(book, command);
        assert.deepEqual(apply(book, command), result);
        const expected = reference.apply(command);
        assert.equal(result.outcome, expected.outcome);
        assert.deepEqual(result.trades, expected.trades);
        assert.deepEqual(result.book, reference.book());

        for (const trade of result.trades) {
          assert(!tradeIds.has(trade.tradeId), 'duplicate trade ID in one instrument');
          tradeIds.add(trade.tradeId);
          for (const id of [trade.buyOrderId, trade.sellOrderId]) {
            filledByOrder.set(id, (filledByOrder.get(id) ?? 0n) + trade.quantity);
          }
        }
        for (const change of result.orderChanges) orders.set(change.id, change);

        assert.equal(orders.size, reference.orders.size);
        for (const [id, order] of orders) {
          const { status, remaining, quantity } = order;
          assert.equal(status, reference.orders.get(id)?.status);
          assert.equal(remaining, reference.orders.get(id)?.remaining);
          assert(remaining >= 0n);
          assert.equal((filledByOrder.get(id) ?? 0n) + remaining, quantity);
        }

        const [bestBid] = result.book.bids;
        const [bestAsk] = result.book.asks;
        if (bestBid && bestAsk) assert(bestBid.price < bestAsk.price, 'crossed book');
        book = result.book;
      }
    }),
    { numRuns: 500, seed: 50233 },
  );
}, 30_000);
