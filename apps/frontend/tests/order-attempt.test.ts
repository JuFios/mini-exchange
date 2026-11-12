import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';

const input = { instrument: 'ABC', side: 'buy' as const, price: '100', quantity: '1' };
const keys: string[] = [];
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
const pending = (id: string) => () => Response.json({ order: { id }, trades: [] }, { status: 202 });

it('sends an identical second order with its own key after a pending acceptance', async () => {
  answers = [pending('first'), pending('second')];

  const first = await send();
  const second = await send();

  assert.deepEqual([first.status, second.status], ['pending', 'pending']);
  assert.deepEqual([first.id, second.id], ['first', 'second']);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

it('repeats the key after a gateway failure and drops it once the order is accepted', async () => {
  answers = [() => new Response('{}', { status: 503 }), pending('first'), pending('second')];

  await assert.rejects(send());
  await send();
  await send();

  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

it('drops the key when the request was refused', async () => {
  answers = [() => new Response('{}', { status: 422 }), pending('first')];

  await assert.rejects(send());
  await send();

  assert.notEqual(keys[0], keys[1]);
});
