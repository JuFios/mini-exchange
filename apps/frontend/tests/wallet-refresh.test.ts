import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, it, mock } from 'node:test';

afterEach(() => mock.restoreAll());

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Таймери з керованим часом: `advance` запускає все, що настало. */
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    timers,
    clock: {
      setTimeout(handler: () => void, ms: number) {
        timers.set(nextId, { at: time + ms, handler });
        return nextId++;
      },
      clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    },
    async advance(ms: number) {
      time += ms;
      for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
        if (timer.at > time || !timers.has(id)) continue;
        timers.delete(id);
        timer.handler();
      }
      await flush();
    },
  };
}

const wallet = (available: string, reserved: string, version: string) => ({
  asset: 'USD',
  available,
  reserved,
  version,
});

function privateSocket(walletReads: (() => Promise<Response>)[]) {
  const { startPrivateSocket } = require('../lib/use-private-socket');
  const requests: string[] = [];
  mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    requests.push(path);
    if (path.endsWith('/ws-token')) return Response.json({ token: 't', userId: 'user-a' });
    if (path.includes('/settlement/wallets')) {
      const next = walletReads.shift();
      if (!next) throw new Error('unexpected wallet read');
      // Як справжній fetch: обірване читання завершується AbortError.
      return Promise.race([
        next(),
        new Promise<Response>((_, reject) =>
          options.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
      ]);
    }
    return Response.json([]);
  });
  const socket = new EventEmitter();
  const time = fakeClock();
  const wallets: ReturnType<typeof wallet>[] = [];
  const errors: unknown[] = [];
  let snapshots = 0;
  const stop = startPrivateSocket(
    'ws://localhost:3001',
    {
      onLoading() {},
      onError: (error: unknown) => errors.push(error),
      onSnapshot() {
        snapshots++;
      },
      knownOrderIds: () => [],
      onOrder() {},
      onWallet: (value: ReturnType<typeof wallet>) => wallets.push(value),
    },
    time.clock,
    (_url: string, options: { auth: (callback: (value: { token: string }) => void) => void }) =>
      Object.assign(socket, {
        active: true,
        connect() {
          options.auth(() => socket.emit('connect'));
        },
        disconnect() {},
      }),
  );
  const walletRequests = () => requests.filter((path) => path.includes('/settlement/wallets'));
  return { socket, time, wallets, errors, stop, walletRequests, snapshots: () => snapshots };
}

const orderEvent = { orderId: 'order-1', version: 1, status: 'open' };

it('rereads the wallets after an own order event whose wallet event was lost', async () => {
  const before = wallet('99900.0000000000', '0.0000000000', '1');
  const after = wallet('99820.0000000000', '80.0000000000', '2');
  const run = privateSocket([
    async () => Response.json([before]),
    async () => Response.json([after]),
  ]);
  await flush();
  assert.equal(run.snapshots(), 1);
  run.socket.emit('order.updated', orderEvent);
  await run.time.advance(1000);
  run.stop();
  assert.deepEqual(run.wallets, [after]);
  assert.equal(run.walletRequests().length, 2);
  assert.equal(run.time.timers.size, 0, 'unmount stops the reconciliation');
});

it('reconciles the wallets on a timer when no order event follows a lost update', async () => {
  const released = wallet('100000.0000000000', '0.0000000000', '3');
  const run = privateSocket([
    async () => Response.json([wallet('99820.0000000000', '80.0000000000', '2')]),
    async () => Response.json([released]),
  ]);
  await flush();
  await run.time.advance(10_000);
  run.stop();
  assert.deepEqual(run.wallets, [released]);
  assert.equal(run.time.timers.size, 0, 'unmount stops the reconciliation');
});

it('stops wallet reads with the connection and ignores a read that lands afterwards', async () => {
  let land: (response: Response) => void = () => undefined;
  const run = privateSocket([
    async () => Response.json([wallet('1.0000000000', '0.0000000000', '1')]),
    () => new Promise<Response>((resolve) => (land = resolve)),
  ]);
  await flush();
  run.socket.emit('order.updated', orderEvent);
  await run.time.advance(1000);
  assert.equal(run.walletRequests().length, 2);
  run.socket.emit('disconnect', 'transport close');
  land(Response.json([wallet('2.0000000000', '0.0000000000', '2')]));
  // Відповідь має встигнути завершитись до дедлайну, інакше перевірку замаскував би abort.
  await flush();
  assert.deepEqual(run.wallets, []);
  await run.time.advance(60_000);
  run.stop();
  assert.deepEqual(run.wallets, []);
  assert.equal(run.walletRequests().length, 2);
  assert.equal(run.time.timers.size, 0);
});

/** Звірка з керованими читаннями: тест сам вирішує, коли й чим завершити кожне. */
function refresher() {
  const { startWalletRefresh } = require('../lib/wallet-refresh');
  const time = fakeClock();
  const reads: { signal: AbortSignal; resolve(value: string): void; reject(e: unknown): void }[] =
    [];
  const seen: string[] = [];
  const refresh = startWalletRefresh(
    (signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => reads.push({ signal, resolve, reject })),
    (value: string) => seen.push(value),
    time.clock,
  );
  return { refresh, time, reads, seen };
}

it('coalesces a burst of order events into one read and is not starved by later events', async () => {
  const { WALLET_EVENT_DELAY_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads } = refresher();
  refresh.start();
  const step = WALLET_EVENT_DELAY_MS / 10;
  for (let elapsed = 0; elapsed < WALLET_EVENT_DELAY_MS; elapsed += step) {
    refresh.changed();
    await time.advance(step);
  }
  // Події йшли всю паузу, але читання не відклалось і було одне на всю пачку.
  assert.equal(reads.length, 1);
  for (let i = 0; i < 10; i++) refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  assert.equal(reads.length, 1, 'events during a read wait for it to settle');
  refresh.stop();
});

it('reads again after an in-flight read when an order event arrived meanwhile', async () => {
  const { WALLET_EVENT_DELAY_MS, WALLET_REFRESH_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads, seen } = refresher();
  refresh.start();
  refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  assert.equal(reads.length, 1);
  refresh.changed();
  refresh.changed();
  reads[0].resolve('first');
  await time.advance(0);
  await time.advance(WALLET_EVENT_DELAY_MS);
  assert.equal(reads.length, 2, 'the event during the read gets its own read');
  reads[1].resolve('second');
  await time.advance(0);
  // Без нових подій наступне читання — лише за періодом.
  await time.advance(WALLET_REFRESH_MS - 1);
  assert.equal(reads.length, 2);
  await time.advance(1);
  assert.equal(reads.length, 3);
  refresh.stop();
  assert.deepEqual(seen, ['first', 'second']);
});

it('aborts a hanging read, keeps reconciling and drops a failed read silently', async () => {
  const { WALLET_REFRESH_MS, WALLET_TIMEOUT_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads, seen } = refresher();
  refresh.start();
  await time.advance(WALLET_REFRESH_MS);
  assert.equal(reads.length, 1);
  await time.advance(WALLET_TIMEOUT_MS);
  assert.equal(reads[0].signal.aborted, true);
  // Відповідь після дедлайну вже не застосовується.
  reads[0].resolve('late');
  reads[0].reject(new DOMException('aborted', 'AbortError'));
  await time.advance(WALLET_REFRESH_MS);
  assert.equal(reads.length, 2);
  reads[1].reject(new TypeError('Failed to fetch'));
  await time.advance(0);
  await time.advance(WALLET_REFRESH_MS);
  assert.equal(reads.length, 3);
  reads[2].resolve('fresh');
  await time.advance(0);
  refresh.stop();
  assert.deepEqual(seen, ['fresh']);
  assert.equal(time.timers.size, 0);
});

it('schedules nothing after stop, even from a read that settles later', async () => {
  const { WALLET_EVENT_DELAY_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads, seen } = refresher();
  refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  refresh.changed();
  refresh.stop();
  assert.equal(reads[0].signal.aborted, true);
  assert.equal(time.timers.size, 0, 'stop also clears the deadline of the read in flight');
  reads[0].resolve('late');
  await time.advance(0);
  refresh.changed();
  refresh.start();
  await time.advance(60_000);
  assert.equal(reads.length, 1);
  assert.deepEqual(seen, []);
  assert.equal(time.timers.size, 0);
});

it('waits for the first snapshot before the periodic reads start', async () => {
  const { WALLET_EVENT_DELAY_MS, WALLET_REFRESH_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads } = refresher();
  refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  reads[0].resolve('during loading');
  await time.advance(0);
  await time.advance(WALLET_REFRESH_MS * 3);
  assert.equal(reads.length, 1, 'no periodic read before start');
  refresh.start();
  await time.advance(WALLET_REFRESH_MS);
  assert.equal(reads.length, 2);
  refresh.stop();
});

it('keeps the deadline of the next read when an aborted read settles late', async () => {
  const { WALLET_EVENT_DELAY_MS, WALLET_TIMEOUT_MS } = require('../lib/wallet-refresh');
  const { refresh, time, reads, seen } = refresher();
  refresh.start();
  refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  await time.advance(WALLET_TIMEOUT_MS);
  assert.equal(reads[0].signal.aborted, true);
  refresh.changed();
  await time.advance(WALLET_EVENT_DELAY_MS);
  assert.equal(reads.length, 2);
  // Перше читання завершується вже під час другого.
  reads[0].resolve('late');
  await time.advance(0);
  await time.advance(WALLET_TIMEOUT_MS);
  assert.equal(reads[1].signal.aborted, true, 'the second read still has its deadline');
  refresh.stop();
  assert.deepEqual(seen, []);
});

it('stops the previous reconciliation when a connect arrives without a disconnect', async () => {
  const run = privateSocket([
    async () => Response.json([wallet('1.0000000000', '0.0000000000', '1')]),
    async () => Response.json([wallet('1.0000000000', '0.0000000000', '1')]),
  ]);
  await flush();
  assert.equal(run.time.timers.size, 1, 'the first connection plans its reconciliation');
  run.socket.emit('connect');
  await flush();
  assert.equal(run.time.timers.size, 1, 'only the new connection keeps a timer');
  run.stop();
  assert.equal(run.time.timers.size, 0);
});

it('drops a malformed background read without an error and applies the next one', async () => {
  const fresh = wallet('5.0000000000', '0.0000000000', '5');
  const abc = { asset: 'ABC', available: '1.00000000', reserved: '0.00000000', version: '4' };
  const run = privateSocket([
    async () => Response.json([wallet('1.0000000000', '0.0000000000', '1')]),
    async () => Response.json({ not: 'a list' }),
    async () => Response.json([{ asset: 'USD', available: 'x', reserved: '0', version: '9' }, abc]),
    async () => Response.json([fresh]),
  ]);
  await flush();
  for (let i = 0; i < 3; i++) await run.time.advance(10_000);
  run.stop();
  assert.deepEqual(run.errors, []);
  // Хибний USD відкинуто, валідний ABC із тієї ж відповіді застосовано.
  assert.deepEqual(run.wallets, [abc, fresh]);
});
