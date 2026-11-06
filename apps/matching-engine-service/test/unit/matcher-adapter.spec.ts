import type { Order } from '../../src/orders/entities/order.entity';
import { matchOrder } from '../../src/orders/matcher';

const ask: Order = {
  id: 'ask',
  ownerId: 'seller',
  side: 'sell',
  instrument: 'ABC',
  price: '100.00',
  quantity: '1.00000000',
  remainingQuantity: '1.00000000',
  status: 'open',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};
const buy: Order = { ...ask, id: 'buy', ownerId: 'buyer', side: 'buy' };

it('uses sequences for equally priced orders when they are supplied for the book and command', () => {
  const later = { ...ask, id: 'later', priority_seq: 7n };
  const earlier = { ...ask, id: 'earlier', priority_seq: 3n };
  const result = matchOrder({ bids: [], asks: [later, earlier] }, { ...buy, priority_seq: 8n });
  expect(result.trades).toMatchObject([{ sellOrderId: 'earlier' }]);
  expect(result.updatedAsks).toEqual([later]);
});

it('preserves arrival order on equal timestamps and gives each unsequenced fill a stable ID', () => {
  const secondAsk = { ...ask, id: 'second' };
  const book = { bids: [], asks: [ask, secondAsk] };
  const first = matchOrder(book, buy);
  const next = matchOrder(book, { ...buy, id: 'next-buy' });
  expect(first).toEqual(matchOrder(book, buy));
  expect(first.trades).toMatchObject([{ sellOrderId: ask.id, executedAt: buy.createdAt }]);
  expect(first.trades[0].id).not.toBe(next.trades[0].id);
});
