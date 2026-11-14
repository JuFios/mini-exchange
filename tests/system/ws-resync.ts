import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';
import {
  startBookSession,
  type BookState,
  type BookStatus,
  type SocketLike,
} from '../../apps/frontend/lib/book-session';
import { container, docker, engine, request, submit, until, waitReady } from './helpers';
import { adminToken, owner, testUser, withFreshBook } from './workload';

async function restBook(): Promise<BookState> {
  const response = await request('/instruments/ABC/book');
  assert.equal(response.status, 200);
  return (await response.json()) as BookState;
}

async function addOrders(count: number, auth: string) {
  await Promise.all(
    Array.from({ length: count }, async () => {
      const response = await submit(auth, {
        instrument: 'ABC',
        side: 'buy',
        price: '90',
        quantity: '0.1',
      });
      assert(response.ok, await response.clone().text());
    }),
  );
}

void withFreshBook(async (db) => {
  const [admin, trader] = await Promise.all([adminToken(), testUser()]);
  const socket = io(`${engine}/market`, { autoConnect: false, transports: ['websocket'] });
  let instance: string | undefined;
  let book: BookState | undefined;
  let status: BookStatus = 'reconnecting';
  let dropSeq: string | undefined;
  let droppedAt: number | undefined;
  let snapshots = 0;
  let subscribes = 0;
  let heartbeats = 0;
  const states: { status: BookStatus; at: number }[] = [];

  // Перехоплюємо кадр перед тим, як його отримає той самий автомат, що працює в браузері.
  const transport: SocketLike = {
    get active() {
      return socket.active;
    },
    on(event, handler) {
      socket.on(event, (...args: unknown[]) => {
        if (event === 'book.heartbeat') heartbeats++;
        if (event === 'book.delta' && dropSeq && (args[0] as { seq: string }).seq === dropSeq) {
          dropSeq = undefined;
          droppedAt = performance.now();
          return;
        }
        handler(...(args as never[]));
      });
    },
    timeout(ms) {
      return {
        emit(event, ...args) {
          assert.equal(event, 'book.subscribe');
          subscribes++;
          const [body, callback] = args as [
            unknown,
            (error: Error | null, reply?: unknown) => void,
          ];
          socket
            .timeout(ms)
            .emit(
              event,
              body,
              (error: Error | null, reply?: { ok: boolean; instance?: string }) => {
                if (reply?.ok) instance = reply.instance;
                callback(error, reply);
              },
            );
        },
      };
    },
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
  };
  const stop = startBookSession(transport, 'ABC', {
    onBook(value) {
      book = value;
    },
    onStatus(value) {
      status = value;
      states.push({ status, at: performance.now() });
    },
    onSnapshot() {
      snapshots++;
    },
  });
  let stoppedReplica: string | undefined;
  let frozenService: string | undefined;
  const chaos = (service: string, point: string) =>
    request('/admin/chaos', 'POST', admin, { point }, `http://${service}:3001`);
  const waitApplied = (seq: string) =>
    until(
      () => owner(db),
      (state) => state.last_applied_seq === seq,
    );
  async function afterHeartbeat() {
    const previous = heartbeats;
    await until(async () => heartbeats > previous, Boolean, 4000);
    await delay(250);
  }
  async function checkLive(
    seq: string,
    previousSnapshots: number,
    phase: number,
    transition: BookStatus,
  ) {
    await until(
      async () =>
        status === 'live' &&
        book?.seq === seq &&
        snapshots > previousSnapshots &&
        states.slice(phase).some((state) => state.status === transition),
      Boolean,
      15000,
    );
    assert.deepEqual(book, await restBook());
    assert(instance === 'engine-1' || instance === 'engine-2');
  }
  try {
    socket.connect();
    await checkLive('0', 0, 0, 'loading');
    {
      const phase = states.length;
      const before = snapshots;
      socket.io.reconnection(false);
      socket.io.engine.close();
      await until(async () => status === 'reconnecting', Boolean);
      await addOrders(50, trader);
      await waitApplied('50');
      socket.io.reconnection(true);
      socket.connect();
      await checkLive('50', before, phase, 'reconnecting');
      console.log('ws=transport-close seq=50 ordersDuringDisconnect=50');
    }
    {
      const phase = states.length;
      const before = snapshots;
      const old = instance;
      stoppedReplica = container(`matching-${old}`);
      docker('kill', '--signal', 'KILL', stoppedReplica);
      await checkLive('50', before, phase, 'reconnecting');
      assert.notEqual(instance, old);
      docker('start', stoppedReplica);
      await waitReady(`matching-${old}`);
      stoppedReplica = undefined;
      console.log(`ws=replica-kill seq=50 from=${old} to=${instance}`);
    }
    {
      const phase = states.length;
      const before = snapshots;
      const attempts = subscribes;
      await afterHeartbeat();
      dropSeq = '51';
      await addOrders(1, trader);
      await checkLive('51', before, phase, 'stale');
      assert.equal(
        subscribes,
        attempts + 1,
        'A missed delta should trigger exactly one snapshot request',
      );
      const stale = states.slice(phase).find((state) => state.status === 'stale');
      assert(stale && droppedAt !== undefined);
      const staleMs = stale.at - droppedAt;
      assert(staleMs >= 0 && staleMs <= 4000, `Heartbeat detection took ${staleMs}ms`);
      console.log(`ws=last-delta-loss seq=51 snapshots=1 staleMs=${Math.round(staleMs)}`);
    }
    {
      const phase = states.length;
      const before = snapshots;
      const old = instance;
      frozenService = `matching-${old}`;
      assert.equal((await chaos(frozenService, 'freeze_stream_reader')).status, 201);
      await afterHeartbeat();
      await addOrders(20, trader);
      await waitApplied('71');
      const appliedAt = (
        await db.query("SELECT applied_at FROM order_commands WHERE instrument='ABC' AND seq=52")
      ).rows[0].applied_at as Date;
      // PG і runner мають спільний годинник хоста Docker.
      const anchor = performance.now() - (Date.now() - appliedAt.getTime());
      const stale = await until(
        async () => states.slice(phase).find((state) => state.status === 'stale'),
        Boolean,
        4000,
      );
      assert(
        stale && stale.at >= anchor && stale.at - anchor <= 4000,
        `Frozen reader stale detection took ${stale ? stale.at - anchor : 'unknown'}ms`,
      );
      await checkLive('71', before, phase, 'reconnecting');
      assert.notEqual(instance, old);
      assert.equal((await chaos(frozenService, 'unfreeze_stream_reader')).status, 201);
      frozenService = undefined;
      console.log(
        `ws=frozen-reader seq=71 from=${old} to=${instance} staleMs=${Math.round(stale.at - anchor)}`,
      );
    }
    {
      // Попередні фази звіряють книгу одразу після snapshot. Тут вона зібрана лише з delta:
      // нові рівні й зміна наявного рівня 90.
      await until(async () => status === 'live' && book?.seq === '71', Boolean, 15000);
      const before = snapshots;
      const attempts = subscribes;
      await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          const response = await submit(trader, {
            instrument: 'ABC',
            side: 'buy',
            price: i < 10 ? String(80 + i) : '90',
            quantity: '0.1',
          });
          assert(response.ok, await response.clone().text());
        }),
      );
      await waitApplied('91');
      await until(async () => book?.seq === '91', Boolean, 15000);
      assert.equal(status, 'live');
      assert.equal(snapshots, before, 'Live deltas must not need a new snapshot');
      assert.equal(subscribes, attempts);
      assert.deepEqual(book, await restBook());
      console.log(`ws=live-deltas seq=91 snapshots=0 levels=${book?.bids.length}`);
    }
  } finally {
    stop();
    if (frozenService) await chaos(frozenService, 'unfreeze_stream_reader');
    if (stoppedReplica) docker('start', stoppedReplica);
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
