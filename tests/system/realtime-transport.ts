import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { database, request, submit, token, until, waitReady } from './helpers';

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
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No acknowledgement in 10 s')), 10000);
    socket.once('connect_error', reject);
    socket.once('connect', () =>
      socket.emit('book.subscribe', { instrument: 'ABC' }, (ack: { instance?: string }) => {
        clearTimeout(timer);
        resolve(String(ack.instance));
      }),
    );
  }).finally(() => socket.disconnect());
}

/** Завислу репліку LB обходить: жодне підключення не потрапляє на неї й не зазнає відмови. */
async function routesAroundStaleReplica() {
  const admin = await token('login', process.env.ADMIN_EMAIL!, process.env.ADMIN_PASSWORD!);
  const seller = await token('register', `${randomUUID()}@system.test`, 'transport-user-password');
  const stale = 'http://matching-engine-2:3001';
  const chaos = (point: string) => request('/admin/chaos', 'POST', admin, { point }, stale);
  try {
    assert.equal((await chaos('freeze_stream_reader')).status, 201);
    const accepted = await submit(seller, {
      instrument: 'ABC',
      side: 'sell',
      price: '100',
      quantity: '1',
    });
    assert([200, 201, 202].includes(accepted.status));
    await until(
      async () => (await request('/ready', 'GET', undefined, undefined, stale)).status,
      (status) => status === 503,
      40000,
    );
    const instances = new Set<string>();
    for (let attempt = 0; attempt < 20; attempt++) instances.add(await subscribeThroughBalancer());
    assert.deepEqual([...instances], ['engine-1'], 'Only the healthy replica may accept clients');
    console.log('stale replica bypassed by the load balancer connects=20 instance=engine-1: PASS');
  } finally {
    await chaos('unfreeze_stream_reader');
    await waitReady('matching-engine-2');
  }
}

async function main() {
  const db = database();
  await db.connect();
  try {
    assert(
      (await db.query('SELECT pg_try_advisory_lock(894215631024) AS ok')).rows[0].ok,
      'Another ownership system check is already running',
    );
    for (const base of ['http://engine-lb:3001', 'http://engine-lb:8080']) {
      const rest = await request('/instruments/ABC/book', 'GET', undefined, undefined, base);
      assert.equal(rest.status, 200);
      const { bids, asks } = (await rest.json()) as { bids: unknown[]; asks: unknown[] };
      const metrics = await request('/metrics', 'GET', undefined, undefined, base);
      assert.equal(metrics.status, base.endsWith(':3001') ? 404 : 200);
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
          assert.deepEqual(snapshot, { bids, asks });
          socket.disconnect();
        }
      } finally {
        socket.disconnect();
      }
      console.log(`transport listener=${base} connects=2 snapshots=2 pollingRejected=2: PASS`);
    }
    await routesAroundStaleReplica();
  } finally {
    await db.end();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
