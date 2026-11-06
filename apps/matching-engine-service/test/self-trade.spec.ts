import { matchOrder } from '../src/orders/matcher';
import type { Order } from '../src/orders/entities/order.entity';
import type { MatchResult } from '../src/orders/order-book.types';

function makeOrder(overrides: Partial<Order>): Order {
  return {
    id: overrides.id ?? 'order-' + Math.random(),
    ownerId: overrides.ownerId ?? 'owner-1',
    instrument: overrides.instrument ?? 'ABC',
    side: overrides.side ?? 'buy',
    price: overrides.price ?? '100.00',
    quantity: overrides.quantity ?? '1.00000000',
    remainingQuantity: overrides.remainingQuantity ?? overrides.quantity ?? '1.00000000',
    status: overrides.status ?? 'open',
    createdAt: overrides.createdAt ?? new Date(),
  };
}

describe('self-trade prevention', () => {
  const restingSell = makeOrder({
    id: 'sell-1',
    ownerId: 'same-owner',
    side: 'sell',
    price: '100.00',
    quantity: '1.00000000',
  });
  const incomingBuy = makeOrder({
    id: 'buy-1',
    ownerId: 'same-owner',
    side: 'buy',
    price: '100.00',
    quantity: '1.00000000',
  });
  const book = { bids: [], asks: [restingSell] };

  function assertPreventsSelfTrade(result: MatchResult) {
    expect(result.trades).toEqual([]);
    expect(result.updatedAsks).toEqual([restingSell]);
    expect(result.updatedBids).toEqual([]);
    expect(result.restingOrder).toBeNull();
    expect(result).toMatchObject({
      cancelledIncoming: { id: incomingBuy.id, status: 'cancelled' },
    });
  }

  it('does not match two orders from the same owner', () => {
    assertPreventsSelfTrade(matchOrder(book, incomingBuy));
  });

  it('detects a no-op policy that a truthiness assertion misses', () => {
    try {
      jest.isolateModules(() => {
        jest.doMock('../src/matching/stp', () => ({ cancelNewest: () => false }));
        const { matchOrder: matchWithNoStp } =
          jest.requireActual<typeof import('../src/orders/matcher')>('../src/orders/matcher');
        const result = matchWithNoStp(book, incomingBuy);

        expect(result).toBeTruthy();
        expect(result.trades).toMatchObject([{ buyOrderId: incomingBuy.id, sellOrderId: restingSell.id }]);
        expect(() => assertPreventsSelfTrade(result)).toThrow();
      });
    } finally {
      jest.dontMock('../src/matching/stp');
    }
  });
});
