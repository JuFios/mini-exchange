import { toRejectedInternal } from '../../src/engine/command-applier';
import { OrderBookService } from '../../src/orders/order-book.service';

it('releases the full rejected buy reservation with an empty delta', () => {
  const result = toRejectedInternal({ bids: [], asks: [] }, { id: 'id', ownerId: 'u', side: 'buy', price: 10000n, quantity: 200000000n, remaining: 200000000n, prioritySeq: 1n });
  expect(result).toMatchObject({ outcome: 'rejected_internal', levelChanges: [], trades: [], closed: [{ reason: 'rejected', releasedAmount: 2000000000000n }] });
  expect(result.orderChanges).toMatchObject([{ status: 'cancelled', cancelReason: 'rejected' }]);
});

it('caches aggregate levels after a commit and protects them from callers', () => {
  const service = new OrderBookService();
  const order = { id: 'id', ownerId: 'u', side: 'sell' as const, price: 10000n, quantity: 200000000n, remaining: 100000000n, prioritySeq: 1n };
  service.commit('ABC', { bids: [{ ...order, side: 'buy', price: 9900n }], asks: [order, { ...order, id: 'two' }] }, '7');
  const result = service.depth('ABC');
  expect(result).toEqual({ bids: [{ price: '99.00', quantity: '1.00000000', orders: 1 }], asks: [{ price: '100.00', quantity: '2.00000000', orders: 2 }] });
  result.bids[0].quantity = '999';
  result.asks[0].quantity = '999';
  expect(service.depth('ABC').bids[0].quantity).toBe('1.00000000');
  expect(service.depth('ABC').asks[0].quantity).toBe('2.00000000');
  expect(service.sequence('ABC')).toBe('7');
});
