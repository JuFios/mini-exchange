import { matchOrder } from '../src/orders/matcher';
import { Order } from '../src/orders/entities/order.entity';

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
  it('does not match two orders from the same owner', () => {
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

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades).toEqual([]);
    expect(result.updatedAsks).toEqual([restingSell]);
    expect(result.updatedBids).toEqual([]);
    expect(result.restingOrder).toBeNull();
    expect(result).toMatchObject({
      cancelledIncoming: { id: incomingBuy.id, status: 'cancelled' },
    });
  });
});
