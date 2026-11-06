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

describe('a snapshot that mixes sequenced and unsequenced orders', () => {
  const later = { ...ask, id: 'later', priority_seq: 7n, createdAt: new Date('2026-01-01T00:00:00Z') };
  const earlier = { ...ask, id: 'earlier', priority_seq: 3n, createdAt: new Date('2026-01-01T00:00:05Z') };
  const incoming = { ...buy, id: 'incoming', priority_seq: 8n };

  it('is rejected when the unsequenced order is on the other side of the book', () => {
    const bid: Order = { ...buy, id: 'unsequenced-bid', price: '50.00' };
    expect(() => matchOrder({ bids: [bid], asks: [later, earlier] }, incoming)).toThrow(/sequence/i);
  });

  it('is rejected when the unsequenced order is on the same side of the book', () => {
    const otherAsk: Order = { ...ask, id: 'unsequenced-ask' };
    expect(() => matchOrder({ bids: [], asks: [later, earlier, otherAsk] }, incoming)).toThrow(/sequence/i);
  });
});

it('rejects a sequenced snapshot with an unsequenced incoming order', () => {
  const sequencedAsk = { ...ask, priority_seq: 1n };
  expect(() => matchOrder({ bids: [], asks: [sequencedAsk] }, buy)).toThrow(/sequence/i);
});

it('ranks unsequenced orders without comparing creation times pairwise', () => {
  const size = 5_000;
  const asks = Array.from({ length: size }, (_, index): Order => ({
    ...ask,
    id: `ask-${index}`,
    price: formatTicks(10_000 + index),
    // Послідовність часу створення псевдовипадкова: відсортований вхід не дає навантаження порівнянь.
    createdAt: new Date(Date.UTC(2026, 0, 1) + ((index * 7919) % size)),
  }));
  const getTime = jest.spyOn(Date.prototype, 'getTime');
  try {
    const result = matchOrder({ bids: [], asks }, { ...buy, price: '1.00', createdAt: new Date(Date.UTC(2026, 1, 1)) });
    expect(result.restingOrder).not.toBeNull();
    // Лінійна кількість звернень: по одному на заявку, а не по два на кожне порівняння сортування.
    expect(getTime.mock.calls.length).toBeLessThanOrEqual(3 * size);
  } finally {
    getTime.mockRestore();
  }
});

function formatTicks(ticks: number): string {
  return (ticks / 100).toFixed(2);
}
