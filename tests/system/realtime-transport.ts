import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import {
  cancelOrder,
  cleanup,
  database,
  request,
  submit,
  token,
  until,
  waitReady,
} from './helpers';

const balancer = 'http://engine-lb:3001';

/** Підписка на `/market` через LB; `instance` в ack показує, яка репліка її прийняла. */
function subscribeThroughBalancer(): Promise<string> {
  // Без forceNew клієнт узяв би Manager попереднього сокета з тим самим origin (autoConnect: false).
  const socket = io(`${balancer}/market`, {
    forceNew: true,
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });
  let timer: NodeJS.Timeout | undefined;
  return new Promise<string>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('No acknowledgement in 10 s')), 10000);
    socket.once('connect_error', reject);
    socket.once('connect', () =>
      socket.emit('book.subscribe', { instrument: 'ABC' }, (ack: { instance?: string }) =>
        resolve(String(ack.instance)),
      ),
    );
  }).finally(() => {
    // Таймер не тримає процес після відмови підключення.
    clearTimeout(timer);
    socket.disconnect();
  });
}

/** Завислу репліку LB обходить: жодне підключення не потрапляє на неї й не зазнає відмови. */
async function routesAroundStaleReplica() {
  const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
  const seller = await token('register', `${randomUUID()}@system.test`, 'transport-user-password');
  const stale = 'http://matching-engine-2:3001';
  const chaos = (point: string) => request('/admin/chaos', 'POST', admin, { point }, stale);
  let restingOrderId: string | undefined;
  let failure: unknown;
  try {
    assert.equal((await chaos('freeze_stream_reader')).status, 201);
    const accepted = await submit(seller, {
      instrument: 'ABC',
      side: 'sell',
      price: '100',
      quantity: '1',
    });
    assert([200, 201, 202].includes(accepted.status));
    restingOrderId = ((await accepted.json()) as { order: { id: string } }).order.id;
    await until(
      async () => (await request('/ready', 'GET', undefined, undefined, stale)).status,
      (status) => status === 503,
      40000,
    );
    const instances = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) instances.add(await subscribeThroughBalancer());
    assert.deepEqual([...instances], ['engine-1'], 'Only the healthy replica may accept clients');
    console.log('stale replica bypassed by the load balancer connects=20 instance=engine-1: PASS');
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(
      failure,
      async () => assert.equal((await chaos('unfreeze_stream_reader')).status, 201),
      () => waitReady('matching-engine-2'),
      // Заявка не повинна лишатися на ABC для наступних сценаріїв.
      () => restingOrderId && cancelOrder(seller, restingOrderId),
    );
  }
}

async function main() {
  const db = database();
  await db.connect();
  let maker: { token: string; orderId: string } | undefined;
  let failure: unknown;
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS ok')).rows[0].ok,
      'Another ownership system check is already running',
    );
    // Порожня книга збіглася б і з snapshot, що завжди порожній: кладемо заявку далеко від ринку.
    const seller = await token(
      'register',
      `${randomUUID()}@system.test`,
      'transport-user-password',
    );
    const placed = await submit(seller, {
      instrument: 'ABC',
      side: 'sell',
      price: '9999',
      quantity: '0.5',
    });
    assert([200, 201, 202].includes(placed.status), await placed.clone().text());
    maker = {
      token: seller,
      orderId: ((await placed.json()) as { order: { id: string } }).order.id,
    };
    const restingId = maker.orderId;
    await until(
      async () => (await db.query('SELECT status FROM orders WHERE id=$1', [restingId])).rows[0],
      (row) => row?.status === 'open',
    );
    const directMetrics = await request(
      '/metrics',
      'GET',
      undefined,
      undefined,
      'http://matching-engine-1:3001',
    );
    assert.equal(directMetrics.status, 200);
    await directMetrics.text();
    for (const base of ['http://engine-lb:3001', 'http://engine-lb:8080']) {
      const rest = await request('/instruments/ABC/book', 'GET', undefined, undefined, base);
      assert.equal(rest.status, 200);
      const expected = (await rest.json()) as {
        instrument: string;
        seq: string;
        bids: unknown[];
        asks: { price: string }[];
      };
      assert(
        expected.asks.some(({ price }) => price === '9999.00'),
        'The resting order must be in the book',
      );
      const metrics = await request('/metrics', 'GET', undefined, undefined, base);
      assert.equal(metrics.status, 404);
      await metrics.text();
      if (base.endsWith(':3001'))
        // Express віддає ці шляхи так само, як `/metrics`, тож nginx має закривати всі варіанти.
        for (const path of ['/Metrics', '/metrics/', '/METRICS/', '/Internal/x', '/internal/x']) {
          const blocked = await request(path, 'GET', undefined, undefined, base);
          assert.equal(blocked.status, 404, path);
          await blocked.text();
        }
      const socket = io(base, {
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        timeout: 5000,
      });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const polling = await request(
            '/socket.io/?EIO=4&transport=polling',
            'GET',
            undefined,
            undefined,
            base,
          );
          assert.equal(polling.status, 400);
          assert.deepEqual(await polling.json(), { code: 0, message: 'Transport unknown' });
          const snapshot = await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('WebSocket snapshot timeout')), 10000);
            const connected = () => socket.emit('subscribe', 'ABC');
            const received = (book: unknown) => finish(undefined, book);
            const failed = (error: Error) => finish(error);
            const finish = (error?: Error, book?: unknown) => {
              clearTimeout(timer);
              socket.off('connect', connected);
              socket.off('book', received);
              socket.off('connect_error', failed);
              if (error) reject(error);
              else resolve(book);
            };
            socket.once('connect', connected);
            socket.once('book', received);
            socket.once('connect_error', failed);
            socket.connect();
          });
          assert.equal(socket.io.engine.transport.name, 'websocket');
          assert.deepEqual(snapshot, expected);
          socket.disconnect();
        }
      } finally {
        socket.disconnect();
      }
      console.log(`transport listener=${base} connects=2 snapshots=2 pollingRejected=2: PASS`);
    }
    await routesAroundStaleReplica();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup(
      failure,
      // Заявка не повинна лишатися на ABC для наступних сценаріїв.
      () => maker && cancelOrder(maker.token, maker.orderId),
      () => db.end(),
    );
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
