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

describe('matchOrder', () => {
  it('matches a crossing buy order against a resting sell order', () => {
    const restingSell = makeOrder({
      id: 'sell-1',
      ownerId: 'owner-A',
      side: 'sell',
      price: '100.00',
      quantity: '1.00000000',
    });
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'owner-B',
      side: 'buy',
      price: '101.00',
      quantity: '1.00000000',
    });

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].quantity).toBe('1.00000000');
    expect(result.trades[0].price).toBe('100.00'); // за ціною заявки, що вже стояла в книзі
    expect(result.restingOrder).toBeNull();
    expect(result.updatedAsks).toHaveLength(0);
  });

  it('partially fills a larger incoming order and leaves the remainder resting', () => {
    const restingSell = makeOrder({
      id: 'sell-1',
      ownerId: 'owner-A',
      side: 'sell',
      price: '100.00',
      quantity: '0.50000000',
    });
    const incomingBuy = makeOrder({
      id: 'buy-1',
      ownerId: 'owner-B',
      side: 'buy',
      price: '100.00',
      quantity: '1.00000000',
    });

    const result = matchOrder({ bids: [], asks: [restingSell] }, incomingBuy);

    expect(result.trades[0].quantity).toBe('0.50000000');
    expect(result.restingOrder?.remainingQuantity).toBe('0.50000000');
    expect(result.restingOrder?.status).toBe('partially_filled');
  });

  it('respects price-time priority among equal-price resting orders', () => {
    const earlier = makeOrder({
      id: 'sell-early',
      ownerId: 'owner-A',
      price: '100.00',
      side: 'sell',
      quantity: '1.00000000',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const later = makeOrder({
      id: 'sell-late',
      ownerId: 'owner-A',
      price: '100.00',
      side: 'sell',
      quantity: '1.00000000',
      createdAt: new Date('2026-01-01T00:00:05Z'),
    });
    const incomingBuy = makeOrder({
      ownerId: 'owner-B',
      side: 'buy',
      price: '100.00',
      quantity: '1.00000000',
    });

    const result = matchOrder({ bids: [], asks: [later, earlier] }, incomingBuy);

    expect(result.trades[0].sellOrderId).toBe('sell-early');
  });
});
