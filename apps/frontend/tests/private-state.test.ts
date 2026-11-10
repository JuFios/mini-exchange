import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { type Order, orderFeedback } from '../lib/private-state';

afterEach(() => mock.restoreAll());

it('reports a self-trade cancellation when the submitted order reaches its final version', () => {
  const pending: Order = {
    id: 'buy',
    instrument: 'ABC',
    side: 'buy',
    price: '22222.00',
    quantity: '2.00000000',
    createdAt: '2026-11-10T00:00:00.000Z',
    status: 'pending',
    version: 0,
    remainingQuantity: '2.00000000',
    filledQuantity: '0.00000000',
  };
  const cancelled: Order = {
    ...pending,
    status: 'cancelled',
    version: 1,
    cancelReason: 'self_trade_prevented',
  };
  const notice = {
    message: 'Заявку скасовано, щоб уникнути угоди з власною заявкою.',
    failed: true,
  };
  assert.equal(orderFeedback(pending, [{ ...cancelled, id: 'other' }]).failed, false);
  assert.deepEqual(orderFeedback(cancelled, [pending]), notice);
  assert.deepEqual(orderFeedback(pending, [cancelled]), notice);
  assert.deepEqual(orderFeedback(pending, [{ ...cancelled, filledQuantity: '1.00000000' }]), {
    message: 'Залишок заявки скасовано, щоб уникнути угоди з власною заявкою.',
    failed: true,
  });
});

it('tells a partially filled order apart from one that only joined the book', () => {
  const order = (status: Order['status']): Order => ({
    id: 'sell',
    instrument: 'ABC',
    side: 'sell',
    price: '100.00',
    quantity: '3.00000000',
    createdAt: '2026-11-10T00:00:00.000Z',
    status,
    version: 1,
    remainingQuantity: '2.00000000',
    filledQuantity: '1.00000000',
  });
  assert.deepEqual(orderFeedback(order('partially_filled'), []), {
    message: 'Заявку частково виконано. Залишок у книзі.',
    failed: false,
  });
  assert.equal(orderFeedback(order('open'), []).message, 'Заявку додано до книги.');
});

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
  const row = (index: number, status = 'open') => ({
    id: `order-${index}`,
    createdAt: '2026-11-10T00:00:00.000Z',
    status,
    version: status === 'filled' ? 2 : 1,
  });
  const open = Array.from({ length: 60 }, (_, index) => row(index));
  const raced = row(60);
  const snapshots: { orders: ReturnType<typeof row>[] }[] = [];
  let issued = 0;
  mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    requests.push((options.method ?? 'GET') + ' ' + path);
    if (path.endsWith('/ws-token')) return Response.json({ token: String(++issued) });
    if (path.endsWith('/orders/order-60')) return Response.json(row(60, 'filled'));
    if (!path.includes('status=active')) return Response.json([]);
    const query = new URL(path, 'http://localhost').searchParams;
    if (query.has('cursor')) {
      const last = issued === 1 ? raced : open.at(-1);
      assert.deepEqual(JSON.parse(Buffer.from(query.get('cursor')!, 'base64url').toString()), {
        id: last?.id,
        createdAt: last?.createdAt,
      });
      return Response.json([]);
    }
    const active = issued === 1 ? [...open, raced] : open;
    return Response.json(active.slice(0, Number(query.get('limit') ?? 50)));
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
      onSnapshot(snapshot: { orders: ReturnType<typeof row>[] }) {
        snapshots.push(snapshot);
        completed.emit('snapshot');
      },
      knownOrderIds() {
        return snapshots.at(-1)?.orders.map(({ id }) => id) ?? [];
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
  assert.equal(snapshots[0].orders.length, 61);
  assert.equal(snapshots[1].orders.filter(({ status }) => status === 'open').length, 60);
  assert.deepEqual(
    snapshots[1].orders.find(({ id }) => id === raced.id),
    row(60, 'filled'),
  );
  for (const request of [
    'POST /api/auth/ws-token',
    'GET /api/engine/orders?status=active&limit=100',
    'GET /api/engine/orders?status=filled&limit=100',
    'GET /api/engine/orders?status=all&limit=100',
    'GET /api/settlement/wallets',
  ]) {
    assert.equal(requests.filter((entry) => entry === request).length, 2, request);
  }
  assert.equal(requests.filter((request) => request.includes('&cursor=')).length, 2);
  assert.equal(requests.filter((request) => request.endsWith('/orders/order-60')).length, 1);
});

it('accepts a decimal comma and edge spaces, and names an empty field', async () => {
  const { submitValidatedOrder, orderTotal } = require('../lib/decimal');
  const limits = {
    tickSize: '0.01',
    lotSize: '0.00000001',
    minQty: '0.00000001',
    maxQty: '1000000',
    maxPrice: '1000000.00',
  };
  const send = mock.fn(async (order: unknown) => order);
  const typed = await submitValidatedOrder(
    { instrument: 'ABC', side: 'sell', price: ' 100,5 ', quantity: '1,25' },
    limits,
    send,
  );
  assert.deepEqual(typed.errors, {});
  assert.deepEqual(send.mock.calls[0].arguments, [
    { instrument: 'ABC', side: 'sell', price: '100.50', quantity: '1.25000000' },
  ]);

  const empty = await submitValidatedOrder(
    { instrument: 'ABC', side: 'buy', price: '  ', quantity: '' },
    limits,
    send,
  );
  assert.deepEqual(empty.errors, { price: 'Вкажіть ціну', quantity: 'Вкажіть кількість' });
  assert.equal(send.mock.callCount(), 1);

  assert.equal(orderTotal('100,5', '1.5'), '150.7500000000');
  assert.equal(orderTotal('0.01', '0.00000001'), '0.0000000001');
  assert.equal(orderTotal('abc', '1'), undefined);
});

it('sends the user to the sign-in page when the session is gone', async () => {
  const { checkedFetch, ApiError } = require('../lib/client-api');
  const assign = mock.fn();
  Object.assign(globalThis, { window: { location: { assign } } });
  try {
    mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
    await assert.rejects(checkedFetch('/api/engine/orders'), ApiError);
    assert.equal(assign.mock.callCount(), 1);
    assert.deepEqual(assign.mock.calls[0].arguments, ['/login']);
    // Хибний пароль лишає користувача на формі.
    await assert.rejects(checkedFetch('/api/auth/login', { method: 'POST' }), ApiError);
    assert.equal(assign.mock.callCount(), 1);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

it('merges active, filled and recent orders by the highest version', async () => {
  const { startPrivateSocket } = require('../lib/use-private-socket');
  const row = (id: string, status: string, version: number) => ({
    id,
    createdAt: '2026-11-10T00:00:00.000Z',
    status,
    version,
  });
  mock.method(globalThis, 'fetch', async (path: string) => {
    if (path.endsWith('/ws-token')) return Response.json({ token: 'token' });
    if (path.includes('status=active')) {
      const cursor = new URL(path, 'http://localhost').searchParams.has('cursor');
      // `a` ще відкрита в цьому читанні, а `filled` уже бачить її виконаною.
      return Response.json(cursor ? [] : [row('a', 'open', 1), row('tie', 'open', 3)]);
    }
    if (path.includes('status=filled')) {
      return Response.json([row('a', 'filled', 2), row('old-filled', 'filled', 2)]);
    }
    if (path.includes('status=all')) {
      // `old-filled` випав зі сторінки `all`, бо новіших скасованих понад ліміт.
      return Response.json([row('c', 'cancelled', 4), row('tie', 'open', 3)]);
    }
    return Response.json([]);
  });
  const socket = new EventEmitter();
  const completed = new EventEmitter();
  let snapshot: { orders: ReturnType<typeof row>[] } | undefined;
  const stop = startPrivateSocket(
    'ws://localhost:3001',
    {
      onLoading() {},
      onError(error: Error) {
        completed.emit('error', error);
      },
      onSnapshot(value: { orders: ReturnType<typeof row>[] }) {
        snapshot = value;
        completed.emit('snapshot');
      },
      knownOrderIds: () => [],
      onOrder() {},
      onWallet() {},
    },
    { setTimeout: () => undefined, clearTimeout() {} },
    (_url: string, options: { auth: (callback: (value: { token: string }) => void) => void }) =>
      Object.assign(socket, {
        connect() {
          options.auth(() => socket.emit('connect'));
        },
        disconnect() {},
      }),
  );
  await once(completed, 'snapshot');
  stop();
  const byId = new Map(snapshot!.orders.map((order) => [order.id, order]));
  assert.equal(snapshot!.orders.length, 4);
  assert.equal(byId.get('a')?.status, 'filled');
  assert.equal(byId.get('old-filled')?.status, 'filled');
  assert.equal(byId.get('c')?.status, 'cancelled');
  assert.equal(byId.get('tie')?.version, 3);
});

it('keeps an order accepted with a short 202 instead of reporting a failure', () => {
  const { acceptedOrder } = require('../lib/private-state');
  const input = { instrument: 'ABC', side: 'buy', price: '100.00', quantity: '2.00000000' };
  const short = acceptedOrder(input, {
    id: 'new',
    ownerId: 'u',
    instrument: 'ABC',
    status: 'pending',
  });
  assert.equal(short.id, 'new');
  assert.equal(short.status, 'pending');
  assert.equal(short.version, 0);
  assert.equal(short.remainingQuantity, '2.00000000');
  assert.equal(short.price, '100.00');
  const full = {
    ...short,
    version: 1,
    status: 'open',
    createdAt: '2026-11-10T00:00:00.000Z',
    ownerId: 'u',
  };
  assert.deepEqual(acceptedOrder(input, full).status, 'open');
  assert.equal('ownerId' in acceptedOrder(input, full), false);
});

it('words the cancellation notice from the order state and rereads only open orders', () => {
  const { cancelNotice, unresolvedOrderIds } = require('../lib/private-state');
  const order = (id: string, status: Order['status']) => ({ id, status }) as Order;
  assert.equal(cancelNotice(order('a', 'cancelled')).message, 'Заявку скасовано.');
  assert.equal(cancelNotice(order('a', 'filled')).message, 'Заявка встигла виконатися.');
  assert.match(cancelNotice(order('a', 'open')).message, /Очікуємо/);
  assert.match(cancelNotice(undefined).message, /Очікуємо/);

  const ids = unresolvedOrderIds(
    [
      order('open', 'open'),
      order('part', 'partially_filled'),
      order('done', 'filled'),
      order('gone', 'cancelled'),
    ],
    ['event-only'],
  );
  assert.deepEqual([...ids].sort(), ['event-only', 'open', 'part']);
});

it('rejects a pasted amount with extra digits instead of cutting it', async () => {
  const { submitValidatedOrder } = require('../lib/decimal');
  const limits = {
    tickSize: '0.01',
    lotSize: '0.00000001',
    minQty: '0.00000001',
    maxQty: '1000000',
    maxPrice: '1000000.00',
  };
  const send = mock.fn(async (order: unknown) => order);
  const result = await submitValidatedOrder(
    { instrument: 'ABC', side: 'buy', price: '1000000.0051', quantity: '1' },
    limits,
    send,
  );
  assert.ok(result.errors.price);
  assert.equal(send.mock.callCount(), 0);
});

it('sends the bound user with engine requests and reloads when the session changed', async () => {
  const { checkedFetch } = require('../lib/client-api');
  const { bindSession } = require('../lib/session-binding');
  const reload = mock.fn();
  Object.assign(globalThis, { window: { location: { assign() {}, reload } } });
  try {
    const seen: (string | null)[] = [];
    mock.method(globalThis, 'fetch', async (_path: string, options: RequestInit) => {
      seen.push(new Headers(options.headers).get('x-session-user'));
      return new Response(JSON.stringify({ code: 'session_changed', message: 'x' }), {
        status: 409,
      });
    });
    bindSession('user-a');
    await assert.rejects(checkedFetch('/api/engine/orders', { method: 'POST' }));
    await assert.rejects(checkedFetch('/api/auth/ws-token', { method: 'POST' }));
    assert.deepEqual(seen, ['user-a', null]);
    assert.equal(reload.mock.callCount(), 2);
  } finally {
    bindSession(undefined);
    Reflect.deleteProperty(globalThis, 'window');
  }
});

it('retries the initial read on the same connection after a transient failure', async () => {
  const { startPrivateSocket } = require('../lib/use-private-socket');
  let fail = true;
  mock.method(globalThis, 'fetch', async (path: string) => {
    if (path.endsWith('/ws-token')) return Response.json({ token: 't', userId: 'user-a' });
    if (fail && path.includes('/settlement/wallets')) return new Response('{}', { status: 503 });
    return Response.json([]);
  });
  const socket = new EventEmitter();
  const completed = new EventEmitter();
  const timers: (() => void)[] = [];
  const events: string[] = [];
  const stop = startPrivateSocket(
    'ws://localhost:3001',
    {
      onSession(id: string) {
        events.push('session:' + id);
      },
      onLoading() {},
      onError() {
        events.push('error');
      },
      onSnapshot() {
        events.push('snapshot');
        completed.emit('snapshot');
      },
      knownOrderIds: () => [],
      onOrder() {},
      onWallet() {},
    },
    { setTimeout: (callback: () => void) => timers.push(callback), clearTimeout() {} },
    (_url: string, options: { auth: (callback: (value: { token: string }) => void) => void }) =>
      Object.assign(socket, {
        connect() {
          options.auth(() => socket.emit('connect'));
        },
        disconnect() {},
      }),
  );
  while (!events.includes('error')) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.length > 0, true, 'a retry must be scheduled without a reconnect');
  fail = false;
  const done = once(completed, 'snapshot');
  timers.at(-1)!();
  await done;
  stop();
  assert.deepEqual(events, ['session:user-a', 'error', 'snapshot']);
});

it('retries only failures that can pass on their own', () => {
  const { transient } = require('../lib/use-private-socket');
  const { ApiError } = require('../lib/client-api');
  for (const status of [408, 429, 502, 503, 504])
    assert.equal(transient(new ApiError(status, '')), true);
  for (const status of [400, 401, 403, 404, 409])
    assert.equal(transient(new ApiError(status, '')), false);
  assert.equal(transient(new TypeError('Failed to fetch')), true);
  assert.equal(transient(new Error('Invalid wallet snapshot')), false);
});
