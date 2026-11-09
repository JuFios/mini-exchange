import {
  parseEnvelope,
  privateOrder,
  privateWallet,
  publicDelta,
  publicTrade,
} from '../../src/realtime/realtime-events';

const entry = (type: string, payload: unknown, changes: Record<string, unknown> = {}) => [
  'eventId',
  'e1',
  'envelope',
  JSON.stringify({ eventId: 'e1', type, version: 1, payload, ...changes }),
];
const delta = { instrument: 'ABC', seq: '7', changes: [] };
const trade = {
  tradeId: 't1',
  instrument: 'ABC',
  seq: '7',
  price: '100.00',
  quantity: '1.00000000',
  takerSide: 'buy',
  executedAt: '2026-01-01T00:00:00.000Z',
};

describe('parseEnvelope', () => {
  it.each([
    ['book.delta', delta],
    ['trade.public', trade],
    ['order.updated', { userId: 'u1', orderId: 'o1' }],
    ['wallet.updated', { userId: 'u1', asset: 'USD' }],
  ])('reads %s', (type, payload) => {
    expect(parseEnvelope(entry(type, payload))).toEqual({ type, eventId: 'e1', payload });
  });

  it.each([
    ['a missing envelope field', ['eventId', 'e1']],
    ['invalid JSON', ['envelope', '{']],
    ['an array payload', entry('book.delta', [])],
    ['an unknown version', entry('book.delta', delta, { version: 2 })],
    ['a type no namespace serves', entry('order.closed', { orderId: 'o1' })],
    ['a missing event ID', entry('book.delta', delta, { eventId: '' })],
    ['a market event without instrument', entry('book.delta', { seq: '7' })],
    ['a market event without seq', entry('book.delta', { instrument: 'ABC' })],
    ['a user event without user', entry('wallet.updated', { asset: 'USD' })],
  ])('skips %s instead of throwing', (_name, fields) => {
    expect(parseEnvelope(fields)).toBeUndefined();
  });
});

describe('client projections', () => {
  const internal = {
    userId: 'u1',
    buyerUserId: 'u1',
    sellerUserId: 'u2',
    ownerId: 'u1',
    buyOrderId: 'o1',
    entryId: 'x',
  };

  it('sends only the listed public fields of a delta and a trade', () => {
    expect(publicDelta({ ...delta, ...internal } as never)).toEqual(delta);
    expect(publicTrade({ ...trade, ...internal } as never)).toEqual(trade);
  });

  it('sends the owner only the listed fields of an order and a wallet update', () => {
    const order = {
      orderId: 'o1',
      instrument: 'ABC',
      version: 2,
      status: 'filled',
      remainingQuantity: '0.00000000',
      filledQuantity: '1.00000000',
      cancelReason: undefined,
    };
    expect(privateOrder({ ...order, ...internal } as never)).toEqual(order);
    const wallet = { asset: 'USD', available: '1', reserved: '2', version: '3' };
    expect(privateWallet({ ...wallet, ...internal } as never)).toEqual(wallet);
    for (const projection of [privateOrder({ ...order, ...internal } as never), wallet])
      expect(JSON.stringify(projection)).not.toMatch(/userId|UserId|ownerId|entryId/);
  });
});
