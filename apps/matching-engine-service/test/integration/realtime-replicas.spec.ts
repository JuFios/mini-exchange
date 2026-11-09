import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { Socket } from 'socket.io-client';
import { ChaosHooks } from '../../src/chaos/chaos-hooks';
import { CommittedBook } from '../../src/engine/committed-book';
import { MarketGateway } from '../../src/realtime/market.gateway';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { engineApp } from '../e2e/engine-app';
import { ReferenceMatcher } from '../helpers/reference-matcher';
import { waitFor } from '../helpers/wait-for';
import { connect, emitWithAck, payloads, Received, record } from '../helpers/websocket';

const api = engineApp();
const EVENTS = ['book.delta', 'trade', 'book.heartbeat'];
const sockets: Socket[] = [];
let peer: INestApplication | undefined;
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  await peer?.close();
  peer = undefined;
});

async function join(base: string): Promise<Received[]> {
  const socket = await connect(base, '/market');
  sockets.push(socket);
  const received = record(socket, EVENTS);
  expect(
    await emitWithAck<{ ok: boolean }>(socket, 'book.subscribe', { instrument: 'ABC' }),
  ).toMatchObject({
    ok: true,
  });
  return received;
}
const only = payloads;
const seqs = (received: Received[]) => only(received, 'book.delta').map(({ seq }) => seq);

it('shows clients on different replicas the same gap-free sequence of deltas and trades', async () => {
  peer = await api.build({ INSTANCE_ID: 'peer-reader', ENGINE_WORKER_ENABLED: false });
  const [first, second] = [await join(api.url()), await join(await peer.getUrl())];
  const users = await Promise.all([api.register(), api.register(), api.register()]);

  // Три користувачі з перетином цін дають і угоди, і рівні, що зникають.
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      api.submit(users[i % 3], { side: i % 2 ? 'buy' : 'sell', price: 98 + (i % 5), quantity: 1 }),
    ),
  );
  expect(results.every(({ status }) => status === 201 || status === 202)).toBe(true);

  await waitFor(async () => seqs(first).length === 30 && seqs(second).length === 30, 15000);
  const expected = Array.from({ length: 30 }, (_, i) => String(i + 1));
  expect(seqs(first)).toEqual(expected);
  expect(seqs(second)).toEqual(expected);
  expect(only(second, 'book.delta')).toEqual(only(first, 'book.delta'));
  expect(only(first, 'trade').length).toBeGreaterThan(0);
  expect(only(second, 'trade')).toEqual(only(first, 'trade'));
}, 30000);

type Level = { price: string; quantity: string; orders: number };
type Change = { side: 'bid' | 'ask'; price: string; quantity: string; orders: number };

/** Застосовує delta до рівнів так, як це робитиме клієнт: `"0"` прибирає рівень. */
function applyDeltas(snapshot: { bids: Level[]; asks: Level[] }, deltas: { changes: Change[] }[]) {
  const sides = {
    bid: new Map(snapshot.bids.map((level) => [level.price, level])),
    ask: new Map(snapshot.asks.map((level) => [level.price, level])),
  };
  for (const { changes } of deltas)
    for (const { side, price, quantity, orders } of changes)
      if (quantity === '0') sides[side].delete(price);
      else sides[side].set(price, { price, quantity, orders });
  const sorted = (levels: Map<string, Level>, direction: number) =>
    [...levels.values()].sort((a, b) => (Number(a.price) - Number(b.price)) * direction);
  return { bids: sorted(sides.bid, -1), asks: sorted(sides.ask, 1) };
}

describe('a client that subscribes while commands are being applied', () => {
  it('rebuilds the final book from the snapshot and the deltas that follow it', async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => api.register()));
    let next = 0;
    const workers = Array.from({ length: 10 }, async () => {
      for (let i = next++; i < 120; i = next++)
        await api.submit(users[i % 4], {
          side: (i * 5) % 3 === 0 ? 'buy' : 'sell',
          price: 97 + ((i * 11) % 7),
          quantity: 1 + (i % 3),
        });
    });
    await waitFor(async () => next >= 40, 10000);
    const socket = await connect(api.url(), '/market');
    sockets.push(socket);
    const received = record(socket, EVENTS);
    const ack = await emitWithAck<{ snapshot: { seq: string; bids: Level[]; asks: Level[] } }>(
      socket,
      'book.subscribe',
      { instrument: 'ABC' },
    );
    await Promise.all(workers);
    await waitFor(async () => seqs(received).at(-1) === '120', 15000);

    const from = BigInt(ack.snapshot.seq);
    expect(from).toBeGreaterThan(0n);
    const after = only(received, 'book.delta').filter(({ seq }) => BigInt(seq) > from);
    // Після snapshot не пропущено жодної команди.
    expect(after.map(({ seq }) => seq)).toEqual(
      Array.from({ length: 120 - Number(from) }, (_, i) => String(Number(from) + i + 1)),
    );
    const final = await (await api.request('/instruments/ABC/book')).json();
    expect(final.seq).toBe('120');
    expect(applyDeltas(ack.snapshot, after as never)).toEqual({
      bids: final.bids,
      asks: final.asks,
    });
  }, 60000);

  it('joins the room before it reads the snapshot', async () => {
    const book = api.app().get(CommittedBook);
    const gateway = api.app().get(MarketGateway);
    const original = book.read.bind(book);
    let inRoomWhileReading: boolean | undefined;
    const read = jest.spyOn(book, 'read').mockImplementation(async (...args) => {
      inRoomWhileReading = [...gateway.server.sockets.values()].some((client) =>
        client.rooms.has('book:ABC'),
      );
      return original(...args);
    });
    try {
      await join(api.url());
    } finally {
      read.mockRestore();
    }
    // Команда, закомічена після snapshot, публікується пізніше за приєднання до кімнати.
    expect(inRoomWhileReading).toBe(true);
  });

  it('keeps the room and the deltas when a repeated subscription cannot read a snapshot', async () => {
    const owner = await api.register();
    const received = await join(api.url());
    const read = jest
      .spyOn(api.app().get(CommittedBook), 'read')
      .mockRejectedValue(new ServiceUnavailableException({ code: 'BOOK_BUSY' }));
    try {
      expect(await emitWithAck(sockets[0], 'book.subscribe', { instrument: 'ABC' })).toEqual({
        ok: false,
        error: 'BOOK_BUSY',
      });
    } finally {
      read.mockRestore();
    }
    expect((await api.submit(owner)).status).toBe(201);
    await waitFor(async () => seqs(received).length === 1, 5000);

    // Підписка, що не змогла прочитати snapshot, не лишає сокет у кімнаті.
    const failing = jest
      .spyOn(api.app().get(CommittedBook), 'read')
      .mockRejectedValue(new ServiceUnavailableException({ code: 'BOOK_BUSY' }));
    const other = await connect(api.url(), '/market');
    sockets.push(other);
    const otherReceived = record(other, EVENTS);
    try {
      await emitWithAck(other, 'book.subscribe', { instrument: 'ABC' });
    } finally {
      failing.mockRestore();
    }
    expect((await api.submit(owner, { price: 101 })).status).toBe(201);
    await waitFor(async () => seqs(received).length === 2, 5000);
    expect(seqs(otherReceived)).toEqual([]);
  }, 30000);
});

describe('a reader that loses its Redis connection', () => {
  it('resumes from its last entry without losing or repeating a delta', async () => {
    const owner = await api.register();
    const received = await join(api.url());
    for (let i = 0; i < 10; i++)
      expect((await api.submit(owner, { price: 90 + i })).status).toBe(201);
    await waitFor(async () => seqs(received).length === 10, 5000);

    const reader = api.app().get(RealtimeStreamReader);
    const admin = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
    try {
      const id = await reader['redis'].client('ID');
      await admin.client('KILL', 'ID', String(id));
    } finally {
      admin.disconnect();
    }
    for (let i = 10; i < 20; i++)
      expect((await api.submit(owner, { price: 90 + i })).status).toBe(201);

    await waitFor(async () => seqs(received).length >= 20, 15000);
    expect(seqs(received)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
  }, 30000);
});

describe('with a reader that stops following the stream', () => {
  it('goes stale, leaves the pool and recovers without taking the healthy replica down', async () => {
    peer = await api.build({
      INSTANCE_ID: 'peer-frozen',
      ENGINE_WORKER_ENABLED: false,
      CHAOS_ENABLED: true,
      WS_REPLICA_MAX_LAG_MS: 1000,
    });
    const peerUrl = await peer.getUrl();
    const [healthySocket, frozenSocket] = [await join(api.url()), await join(peerUrl)];
    const frozenClient = sockets[1];
    const owner = await api.register();

    peer.get(ChaosHooks).arm({ point: 'freeze_stream_reader' });
    for (let i = 0; i < 5; i++)
      expect((await api.submit(owner, { price: 100 + i })).status).toBe(201);

    await waitFor(async () => seqs(healthySocket).length === 5, 5000);
    // Heartbeat бере seq з PG, тож замерзла репліка видає розбіжність, а не мовчить.
    await waitFor(
      async () => only(frozenSocket, 'book.heartbeat').some(({ seq }) => seq === '5'),
      6000,
    );
    expect(seqs(frozenSocket)).toEqual([]);

    await waitFor(async () => (await fetch(`${peerUrl}/ready`)).status === 503, 15000, 100);
    await waitFor(async () => !frozenClient.connected, 2000);
    const metrics = await (await fetch(`${peerUrl}/metrics`)).text();
    expect(metrics).toMatch(/ws_replica_lag_seq\{instrument="ABC"\} 5\n/);
    expect((await fetch(`${api.url()}/ready`)).status).toBe(200);
    expect(sockets[0].connected).toBe(true);
    await expect(connect(peerUrl, '/market')).rejects.toThrow('REPLICA_UNAVAILABLE');
    await expect(connect(peerUrl, '/private', 'x')).rejects.toThrow('REPLICA_UNAVAILABLE');

    peer.get(ChaosHooks).arm({ point: 'unfreeze_stream_reader' });
    await waitFor(async () => (await fetch(`${peerUrl}/ready`)).status === 200, 15000, 100);
    const recovered = await connect(peerUrl, '/market');
    sockets.push(recovered);
    const ack = await emitWithAck<{ snapshot: { seq: string } }>(recovered, 'book.subscribe', {
      instrument: 'ABC',
    });
    expect(ack.snapshot.seq).toBe('5');
    expect(
      (await fetch(`${peerUrl}/metrics`).then((response) => response.text())).match(
        /ws_replica_lag_seq\{instrument="ABC"\} (\d+)/,
      )?.[1],
    ).toBe('0');
  }, 60000);
});

describe('with a reader that stops following entries that carry no new delta', () => {
  const entry = (type: string, payload: Record<string, unknown>, seq?: string) => {
    const eventId = `00000000-0000-4000-8000-${String(Date.now()).padStart(12, '0')}`;
    const envelope = JSON.stringify({ eventId, type, version: 1, payload });
    return ['eventId', eventId, ...(seq ? ['seq', seq] : []), 'envelope', envelope];
  };

  it.each([
    [
      'a trade of the command whose delta it already emitted',
      'exchange:market:{ABC}',
      entry(
        'trade.public',
        {
          tradeId: 't1',
          instrument: 'ABC',
          seq: '1',
          price: '100.00',
          quantity: '1.00000000',
          takerSide: 'buy',
          executedAt: '2026-01-01T00:00:00.000Z',
        },
        '1',
      ),
    ],
    [
      'an update on the user stream',
      'exchange:user-events',
      entry('order.updated', { userId: 'u1', orderId: 'o1', instrument: 'ABC' }),
    ],
  ])(
    'leaves the pool when it misses %s',
    async (_name, stream, fields) => {
      peer = await api.build({
        INSTANCE_ID: 'peer-frozen-entries',
        ENGINE_WORKER_ENABLED: false,
        CHAOS_ENABLED: true,
        WS_REPLICA_MAX_LAG_MS: 1000,
      });
      const peerUrl = await peer.getUrl();
      const owner = await api.register();
      expect((await api.submit(owner)).status).toBe(201);
      await waitFor(async () => peer!.get(RealtimeStreamReader).emittedSeq('ABC') === 1n, 5000);

      peer.get(ChaosHooks).arm({ point: 'freeze_stream_reader' });
      const admin = new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
      });
      try {
        await admin.xadd(stream, '*', ...fields);
      } finally {
        admin.disconnect();
      }

      await waitFor(async () => (await fetch(`${peerUrl}/ready`)).status === 503, 15000, 100);
      expect((await fetch(`${api.url()}/ready`)).status).toBe(200);

      peer.get(ChaosHooks).arm({ point: 'unfreeze_stream_reader' });
      await waitFor(async () => (await fetch(`${peerUrl}/ready`)).status === 200, 15000, 100);
    },
    60000,
  );
});

describe('snapshots taken while commands are being applied', () => {
  const units = (text: string, scale: number) => {
    const [whole, fraction = ''] = text.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  const decimal = (value: bigint, scale: number) => {
    const base = 10n ** BigInt(scale);
    return `${value / base}.${(value % base).toString().padStart(scale, '0')}`;
  };
  type Level = { price: string; quantity: string; orders: number };

  it('equals an independent replay of the commands up to their own sequence', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => api.register()));
    const book = api.app().get(CommittedBook);
    const snapshots: { seq: string; bids: Level[]; asks: Level[] }[] = [];
    // Двадцять п'ять одночасних запитів, поки читаються snapshots; решта йде в міру завершення.
    let next = 0;
    const writing = Promise.all(
      Array.from({ length: 25 }, async () => {
        const statuses: number[] = [];
        for (let i = next++; i < 150; i = next++)
          statuses.push(
            (
              await api.submit(users[i % 5], {
                side: (i * 7) % 3 === 0 ? 'buy' : 'sell',
                price: 97 + ((i * 13) % 7),
                quantity: 1 + (i % 3),
              })
            ).status,
          );
        return statuses;
      }),
    );
    for (let i = 0; i < 100; i++) {
      const { seq, bids, asks } = await book.read('ABC');
      snapshots.push({ seq, bids, asks });
    }
    expect((await writing).flat().every((status) => status === 201 || status === 202)).toBe(true);
    await waitFor(
      async () =>
        (
          await api
            .database()
            .query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'")
        )[0].last_applied_seq === '150',
      15000,
    );

    const wanted = new Map<string, typeof snapshots>();
    for (const snapshot of snapshots)
      wanted.set(snapshot.seq, [...(wanted.get(snapshot.seq) ?? []), snapshot]);
    const levels = (orders: { price: bigint; remaining: bigint }[]): Level[] => {
      const grouped = new Map<bigint, { quantity: bigint; orders: number }>();
      for (const { price, remaining } of orders) {
        const level = grouped.get(price) ?? { quantity: 0n, orders: 0 };
        grouped.set(price, { quantity: level.quantity + remaining, orders: level.orders + 1 });
      }
      return [...grouped].map(([price, { quantity, orders }]) => ({
        price: decimal(price, 2),
        quantity: decimal(quantity, 8),
        orders,
      }));
    };
    const reference = new ReferenceMatcher();
    let checked = 0;
    const rows = await api.database().query('SELECT * FROM order_commands ORDER BY seq');
    if (wanted.has('0'))
      for (const snapshot of wanted.get('0')!)
        expect(snapshot).toMatchObject({ bids: [], asks: [] });
    for (const row of rows) {
      reference.apply({
        type: 'submit',
        instrument: row.instrument,
        seq: BigInt(row.seq),
        acceptedAt: row.accepted_at.toISOString(),
        order: {
          id: row.order_id,
          ownerId: row.user_id,
          side: row.payload.side,
          price: units(row.payload.price, 2),
          quantity: units(row.payload.quantity, 8),
          remaining: units(row.payload.quantity, 8),
        },
      });
      for (const snapshot of wanted.get(row.seq) ?? []) {
        const { bids, asks } = reference.book();
        expect({ bids: snapshot.bids, asks: snapshot.asks }).toEqual({
          bids: levels(bids),
          asks: levels(asks),
        });
        checked++;
      }
    }
    expect(checked + (wanted.get('0')?.length ?? 0)).toBe(100);
    expect(new Set(snapshots.map(({ seq }) => seq)).size).toBeGreaterThan(1);
  }, 60000);
});
