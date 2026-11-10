import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { EventEmitter, once } from 'node:events';

afterEach(() => mock.restoreAll());

it('accepts wallet versions five and six while ignoring four', () => {
  const { mergeWallet } = require('../lib/private-state');
  const wallet = (version: string) => ({
    asset: 'USD',
    available: version,
    reserved: '0',
    version,
  });
  const five = mergeWallet(undefined, wallet('5'));
  assert.deepEqual(five, wallet('5'));
  assert.equal(mergeWallet(five, wallet('4')), five);
  assert.deepEqual(mergeWallet(five, wallet('6')), wallet('6'));
});

it('sends only a valid order with decimal strings', async () => {
  const { submitValidatedOrder } = require('../lib/decimal');
  const limits = {
    tickSize: '0.01',
    lotSize: '0.00000001',
    minQty: '0.00000001',
    maxQty: '1000000',
    maxPrice: '1000000.00',
  };
  const send = mock.fn(async (order: unknown) => order);
  for (const price of ['100.005', '0', '1e2', 'abc']) {
    const result = await submitValidatedOrder(
      { instrument: 'ABC', side: 'buy', price, quantity: '1' },
      limits,
      send,
    );
    assert.ok(result.errors.price, price);
  }
  const invalidQuantity = await submitValidatedOrder(
    { instrument: 'ABC', side: 'buy', price: '100.00', quantity: '1000000.00000001' },
    limits,
    send,
  );
  assert.ok(invalidQuantity.errors.quantity);
  assert.equal(send.mock.callCount(), 0);

  const valid = await submitValidatedOrder(
    { instrument: 'ABC', side: 'buy', price: '100.00', quantity: '0.00000001' },
    limits,
    send,
  );
  assert.deepEqual(valid.errors, {});
  assert.equal(send.mock.callCount(), 1);
  assert.deepEqual(send.mock.calls[0].arguments, [
    { instrument: 'ABC', side: 'buy', price: '100.00', quantity: '0.00000001' },
  ]);
});

it('restores private state with a fresh handshake after server expiry', async () => {
  const { startPrivateSocket } = require('../lib/use-private-socket');
  const requests: string[] = [];
  let issued = 0;
  mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    requests.push((options.method ?? 'GET') + ' ' + path);
    return path.endsWith('/ws-token')
      ? Response.json({ token: String(++issued) })
      : Response.json([]);
  });
  const socket = new EventEmitter();
  const completed = new EventEmitter();
  let retry: (() => void) | undefined;
  const tokens: string[] = [];
  const stop = startPrivateSocket(
    'ws://localhost:3001',
    {
      onLoading() {},
      onError(error: Error) {
        completed.emit('error', error);
      },
      onSnapshot() {
        completed.emit('snapshot');
      },
      onOrder() {},
      onWallet() {},
    },
    {
      setTimeout(callback: () => void) {
        retry = callback;
      },
      clearTimeout() {
        retry = undefined;
      },
    },
    (_url: string, options: { auth: (callback: (value: { token: string }) => void) => void }) =>
      Object.assign(socket, {
        connect() {
          options.auth(({ token }) => {
            tokens.push(token);
            socket.emit('connect');
          });
        },
        disconnect() {},
      }),
  );
  await once(completed, 'snapshot');
  const second = once(completed, 'snapshot');
  socket.emit('disconnect', 'io server disconnect');
  assert.ok(retry);
  retry();
  await second;
  stop();
  assert.deepEqual(tokens, ['1', '2']);
  const expected = [
    'POST /api/auth/ws-token',
    'GET /api/engine/orders?status=active',
    'GET /api/engine/orders?status=filled',
    'GET /api/settlement/wallets',
  ];
  assert.deepEqual(requests, [...expected, ...expected]);
});
