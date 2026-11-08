import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { database, request } from './helpers';

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
  } finally {
    await db.end();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
