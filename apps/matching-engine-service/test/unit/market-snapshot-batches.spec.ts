import fc from 'fast-check';
import { ConfigService } from '@nestjs/config';
import { CommittedBook } from '../../src/engine/committed-book';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { MarketGateway } from '../../src/realtime/market.gateway';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

type Ack = { ok: boolean; error?: string; snapshot?: { seq: string } };

let nextId = 0;

/** Сокет `/market`: фіксує версію книги на кожному вході в кімнату. */
class FakeSocket {
  readonly id = `socket-${nextId++}`;
  connected = true;
  readonly rooms = new Set<string>();
  readonly joinedAt: number[] = [];
  constructor(private readonly state: { version: number }) {}
  async join(room: string) {
    this.joinedAt.push(this.state.version);
    this.rooms.add(room);
  }
  async leave(room: string) {
    this.rooms.delete(room);
  }
}

/**
 * Шлюз із книгою: читання 20 мс чекає слот, потім бере версію (як snapshot PG після слота) і
 * повертає її через 50 мс.
 */
function build(fail: () => boolean = () => false) {
  const state = { version: 0, reads: 0, active: 0, maxActive: 0 };
  const book = {
    read: jest.fn(async (instrument: string, _limit?: number, started?: () => void) => {
      state.reads++;
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      started?.();
      const version = state.version;
      try {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (fail()) throw new Error('PG is down');
        return { instrument, seq: String(version), bids: [], asks: [] };
      } finally {
        state.active--;
      }
    }),
  };
  const config = {
    getOrThrow: (key: string) => (key === 'INSTANCE_ID' ? 'engine-test' : 1_000_000),
  };
  const gateway = new MarketGateway(
    config as unknown as ConfigService,
    {} as RealtimeStreamReader,
    {} as ReplicaLagMonitor,
    book as unknown as CommittedBook,
    { has: () => true } as unknown as InstrumentCatalog,
  );
  const subscribe = (socket: FakeSocket) =>
    gateway.subscribe(socket as never, { instrument: 'ABC' }) as Promise<Ack>;
  return { state, subscribe, socket: () => new FakeSocket(state) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('market snapshot reads', () => {
  it('reads one snapshot at a time and never older than the join, for any interleaving', async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('subscribe' as const), who: fc.integer({ min: 0, max: 5 }) }),
      fc.record({ kind: fc.constant('change' as const), who: fc.constant(0) }),
      fc.record({ kind: fc.constant('wait' as const), who: fc.integer({ min: 1, max: 120 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
        jest.useFakeTimers();
        const env = build();
        const sockets = Array.from({ length: 6 }, () => env.socket());
        const acks = new Map(sockets.map((socket) => [socket, [] as Promise<Ack>[]]));
        const queued = new Map(sockets.map((socket) => [socket, 0]));
        let subscribes = 0;
        for (const { kind, who } of ops) {
          if (kind === 'subscribe') {
            const socket = sockets[who];
            // Черга сокета тримає до чотирьох підписок; відмову понад неї перевіряє інший тест.
            if (queued.get(socket)! >= 4) continue;
            subscribes++;
            queued.set(socket, queued.get(socket)! + 1);
            const ack = env.subscribe(socket);
            void ack.finally(() => queued.set(socket, queued.get(socket)! - 1));
            acks.get(socket)!.push(ack);
          } else if (kind === 'change') env.state.version++;
          else await jest.advanceTimersByTimeAsync(who);
        }
        await jest.advanceTimersByTimeAsync(5000);

        expect(env.state.maxActive).toBeLessThanOrEqual(1);
        expect(env.state.reads).toBeLessThanOrEqual(subscribes);
        for (const socket of sockets) {
          const answers = await Promise.all(acks.get(socket)!);
          // Підписки сокета йдуть по черзі, тож k-та відповідь належить k-му входу в кімнату.
          answers.forEach((ack, index) => {
            expect(ack.ok).toBe(true);
            expect(Number(ack.snapshot!.seq)).toBeGreaterThanOrEqual(socket.joinedAt[index]);
          });
        }
        jest.useRealTimers();
      }),
      { numRuns: 150 },
    );
  });

  it('serves a hundred sockets that subscribe together with at most two reads', async () => {
    const env = build();
    const sockets = Array.from({ length: 100 }, () => env.socket());
    const acks = sockets.map((socket) => env.subscribe(socket));
    await jest.advanceTimersByTimeAsync(500);

    expect((await Promise.all(acks)).every(({ ok }) => ok)).toBe(true);
    expect(env.state.reads).toBeLessThanOrEqual(2);
    expect(env.state.maxActive).toBe(1);
  });

  it('tells every socket of a failed shared read and takes the new ones out of the room', async () => {
    const env = build(() => true);
    const sockets = Array.from({ length: 5 }, () => env.socket());
    const acks = sockets.map((socket) => env.subscribe(socket));
    await jest.advanceTimersByTimeAsync(500);

    expect(await Promise.all(acks)).toEqual(
      Array(5).fill({ ok: false, error: 'BOOK_UNAVAILABLE' }),
    );
    expect(sockets.every((socket) => socket.rooms.size === 0)).toBe(true);
  });

  it('reads again for a socket that subscribes after a shared read has started', async () => {
    const env = build();
    const first = env.socket();
    const firstAck = env.subscribe(first);
    // Перше читання вже отримало слот (20 мс) і взяло snapshot.
    await jest.advanceTimersByTimeAsync(30);
    env.state.version++;
    const second = env.socket();
    const secondAck = env.subscribe(second);
    await jest.advanceTimersByTimeAsync(500);

    expect((await firstAck).snapshot!.seq).toBe('0');
    expect((await secondAck).snapshot!.seq).toBe('1');
    expect(env.state.reads).toBe(2);
  });
});
