import type { Order } from '../../../src/orders/entities/order.entity';
import { matchOrder } from '../../../src/orders/matcher';

it('keeps earlier fills and cancels the incoming remainder before the self-cross', () => {
  const ownAsk: Order = {
    id: 'own-ask',
    ownerId: 'X',
    instrument: 'ABC',
    side: 'sell',
    price: '100.00',
    quantity: '1.00000000',
    remainingQuantity: '1.00000000',
    status: 'open',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const otherAsk: Order = {
    ...ownAsk,
    id: 'other-ask',
    ownerId: 'Y',
    price: '99.00',
    createdAt: new Date('2026-01-01T00:00:01Z'),
  };
  const incoming: Order = {
    ...ownAsk,
    id: 'incoming',
    side: 'buy',
    quantity: '2.00000000',
    remainingQuantity: '2.00000000',
    createdAt: new Date('2026-01-01T00:00:02Z'),
  };

  const result = matchOrder({ bids: [], asks: [ownAsk, otherAsk] }, incoming);

  expect(result.trades).toEqual([
    expect.objectContaining({
      buyOrderId: 'incoming',
      sellOrderId: 'other-ask',
      price: '99.00',
      quantity: '1.00000000',
    }),
  ]);
  expect(result.restingOrder).toBeNull();
  expect(result.updatedAsks).toEqual([ownAsk]);
  expect(result.updatedBids).toEqual([]);
  expect(result).toMatchObject({
    cancelledIncoming: {
      id: 'incoming',
      remainingQuantity: '1.00000000',
      status: 'cancelled',
      cancelReason: 'self_trade_prevented',
    },
  });
});
