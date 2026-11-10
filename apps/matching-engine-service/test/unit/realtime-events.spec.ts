import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fieldOf,
  parseEnvelope,
  privateOrder,
  privateWallet,
  publicDelta,
  publicTrade,
  seqOf,
} from '../../src/realtime/realtime-events';

const entry = (type: string, payload: unknown, changes: Record<string, unknown> = {}) => [
  'eventId',
  'e1',
  'envelope',
  JSON.stringify({ eventId: 'e1', type, version: 1, payload, ...changes }),
];
// Події, які виробники справді пишуть у stream (ті самі, що в контрактному тесті).
const fixtures: Record<string, { eventId: string; payload: Record<string, unknown> }> = JSON.parse(
  readFileSync(join(__dirname, '../contract/fixtures/events-v1.json'), 'utf8'),
);
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
    ['order.updated', fixtures['order.updated'].payload],
    ['wallet.updated', fixtures['wallet.updated'].payload],
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
    [
      'a user event without user',
      entry('wallet.updated', { ...fixtures['wallet.updated'].payload, userId: undefined }),
    ],
    ['a non-numeric market seq', entry('book.delta', { ...delta, seq: 'abc' })],
    ['a fractional market seq', entry('trade.public', { ...trade, seq: '1.5' })],
    ['an envelope that is JSON null', ['envelope', 'null']],
    ['an envelope that is a number', ['envelope', '5']],
    ['an envelope that is a string', ['envelope', '"text"']],
    ['an envelope that is an array', ['envelope', '[]']],
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

describe('stream field access', () => {
  it('reads a field only when it exists', () => {
    expect(fieldOf(['a', '1', 'b', '2'], 'b')).toBe('2');
    expect(fieldOf(['a', '1'], 'b')).toBeUndefined();
    expect(fieldOf([], 'a')).toBeUndefined();
  });

  it.each([
    [['seq', '12'], 12n],
    [['seq', '0'], 0n],
    [['seq', ''], undefined],
    [['seq', 'abc'], undefined],
    [['seq', '1.5'], undefined],
    [['seq', '-1'], undefined],
    [['envelope', 'null'], undefined],
    [[], undefined],
  ])('reads seq from %j as %p', (fields, expected) => {
    expect(seqOf(fields)).toBe(expected);
  });
});

// Поля, без яких клієнт не може застосувати подію. Решту (`entryId`, `userId` у публічних) клієнту не віддають.
const REQUIRED: Record<string, string[]> = {
  'book.delta': ['instrument', 'seq', 'changes'],
  'trade.public': ['tradeId', 'instrument', 'seq', 'price', 'quantity', 'takerSide', 'executedAt'],
  'order.updated': [
    'orderId',
    'userId',
    'instrument',
    'version',
    'status',
    'remainingQuantity',
    'filledQuantity',
  ],
  'wallet.updated': ['userId', 'asset', 'available', 'reserved', 'version'],
};

describe('parseEnvelope payload shape', () => {
  it.each(Object.keys(REQUIRED))('accepts the %s event a producer writes', (type) => {
    const { eventId, payload } = fixtures[type];
    expect(parseEnvelope(entry(type, payload, { eventId }))).toEqual({ type, eventId, payload });
  });

  it('accepts extra fields and an order update with a cancel reason', () => {
    const payload = { ...fixtures['order.updated'].payload, cancelReason: 'user', extra: 1 };
    expect(parseEnvelope(entry('order.updated', payload))?.payload).toEqual(payload);
  });

  const missing = Object.entries(REQUIRED).flatMap(([type, fields]) =>
    fields.map((field) => [type, field] as const),
  );

  it.each(missing)('skips %s without %s', (type, field) => {
    const payload = { ...fixtures[type].payload };
    delete payload[field];
    expect(parseEnvelope(entry(type, payload))).toBeUndefined();
  });

  it.each(missing)('skips %s whose %s is null or an object', (type, field) => {
    for (const bad of [null, {}]) {
      const payload = { ...fixtures[type].payload, [field]: bad };
      expect(parseEnvelope(entry(type, payload))).toBeUndefined();
    }
  });

  it.each([
    ['book.delta', { changes: {} }],
    ['book.delta', { changes: [{}] }],
    ['book.delta', { changes: [{ side: 'up', price: '1', quantity: '1', orders: 1 }] }],
    ['book.delta', { changes: [{ side: 'ask', price: 'abc', quantity: '1', orders: 1 }] }],
    ['book.delta', { changes: [{ side: 'ask', price: '1', quantity: '1', orders: '1' }] }],
    ['trade.public', { takerSide: 'both' }],
    ['trade.public', { price: 'abc' }],
    ['trade.public', { quantity: 1 }],
    ['order.updated', { status: 'unknown' }],
    ['order.updated', { version: '2' }],
    ['order.updated', { version: 1.5 }],
    ['order.updated', { remainingQuantity: 'abc' }],
    ['order.updated', { cancelReason: 5 }],
    ['wallet.updated', { version: 7 }],
    ['wallet.updated', { version: '1.5' }],
    ['wallet.updated', { version: 'abc' }],
    ['wallet.updated', { available: 90 }],
    ['wallet.updated', { reserved: 'abc' }],
  ])('skips %s with a malformed field %j', (type, change) => {
    const payload = { ...fixtures[type].payload, ...change };
    expect(parseEnvelope(entry(type, payload))).toBeUndefined();
  });
});
