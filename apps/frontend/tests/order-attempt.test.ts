import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, it, mock } from 'node:test';

const input = { instrument: 'ABC', side: 'buy' as const, price: '100', quantity: '1' };
const keys: string[] = [];
const firstId = randomUUID();
const secondId = randomUUID();
const ownerId = randomUUID();
let answers: (() => Response)[] = [];

beforeEach(() => {
  const stored = new Map<string, string>();
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    },
  });
  keys.length = 0;
  mock.method(globalThis, 'fetch', async (_path: string, init: RequestInit) => {
    keys.push(new Headers(init.headers).get('idempotency-key')!);
    return answers.shift()!();
  });
});
afterEach(() => {
  mock.restoreAll();
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});

const send = () =>
  (require('../lib/order-attempt') as typeof import('../lib/order-attempt')).sendOrder(input);
const pending = (id: string) => () =>
  Response.json(
    {
      order: {
        id,
        ownerId,
        instrument: input.instrument,
        side: input.side,
        status: 'pending',
      },
      trades: [],
    },
    { status: 202 },
  );

it('sends an identical second order with its own key after a pending acceptance', async () => {
  answers = [pending(firstId), pending(secondId)];

  const first = await send();
  const second = await send();

  assert.deepEqual([first.status, second.status], ['pending', 'pending']);
  assert.deepEqual([first.id, second.id], [firstId, secondId]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

it('repeats the key after a gateway failure and drops it once the order is accepted', async () => {
  answers = [() => new Response('{}', { status: 503 }), pending(firstId), pending(secondId)];

  await assert.rejects(send());
  await send();
  await send();

  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

it('drops the key when the request was refused', async () => {
  answers = [() => new Response('{}', { status: 422 }), pending(firstId)];

  await assert.rejects(send());
  await send();

  assert.notEqual(keys[0], keys[1]);
});

it('keeps a separate retry key for each different order after a gateway failure', async () => {
  const sendWith = (order: import('../lib/decimal').OrderInput) =>
    (require('../lib/order-attempt') as typeof import('../lib/order-attempt')).sendOrder(order);
  const others: import('../lib/decimal').OrderInput[] = [
    { ...input, instrument: 'XYZ' },
    { ...input, side: 'sell' as const },
    { ...input, price: '100.01' },
    { ...input, quantity: '1.5' },
  ];
  const failed = () => new Response('{}', { status: 503 });
  answers = [failed, ...others.map(() => failed), pending(firstId)];

  await assert.rejects(send());
  for (const order of others) await assert.rejects(sendWith(order));
  // Та сама заявка в іншому записі чисел повторює свій ключ.
  await sendWith({ ...input, price: '100.00', quantity: '1.00000000' });

  assert.equal(new Set(keys.slice(0, 5)).size, 5);
  assert.equal(keys[5], keys[0]);
});

it('retains the same key after an incomplete successful acknowledgement', async () => {
  answers = [
    () =>
      Response.json(
        { order: { id: firstId, instrument: 'ABC', side: 'buy' }, trades: [] },
        { status: 201 },
      ),
    () =>
      Response.json(
        {
          order: {
            id: secondId,
            instrument: 'XYZ',
            side: 'buy',
            status: 'pending',
            ownerId,
          },
          trades: [],
        },
        { status: 202 },
      ),
    pending('invalid-id'),
    pending(firstId),
  ];
  await assert.rejects(send());
  await assert.rejects(send());
  await assert.rejects(send());
  await send();
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0], keys[2]);
  assert.equal(keys[0], keys[3]);
});

it('retains a retry key when sessionStorage is unavailable', async () => {
  Reflect.deleteProperty(globalThis, 'sessionStorage');
  answers = [
    () => {
      throw new Error('Connection reset after acceptance');
    },
    pending(firstId),
  ];
  await assert.rejects(send());
  await send();
  assert.equal(keys[0], keys[1]);
});
