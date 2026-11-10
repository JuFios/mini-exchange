import fc from 'fast-check';
import { CommittedBook } from '../../src/engine/committed-book';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { OrdersGateway } from '../../src/orders/gateway/orders.gateway';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

type Book = { bids: { price: string }[]; asks: never[] };

/** Сокет-заглушка: фіксує книги, які йому надіслано, і не приймає нічого після розриву. */
class FakeSocket {
  connected = true;
  received: number[] = [];
  constructor(private readonly rooms: Map<string, Set<FakeSocket>>) {}
  join(room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set());
    this.rooms.get(room)!.add(this);
  }
  emit(event: string, book: Book) {
    if (!this.connected) throw new Error('emit to a disconnected socket');
    if (event === 'book') this.received.push(Number(book.bids[0].price));
  }
  disconnect() {
    this.connected = false;
    for (const room of this.rooms.values()) room.delete(this);
  }
}

function build() {
  const rooms = new Map<string, Set<FakeSocket>>();
  const state = { version: 0, reads: 0 };
  const book = {
    // Версія береться на початку читання, а книга надходить із затримкою: так виглядає старіша.
    read: jest.fn(async () => {
      state.reads++;
      const version = state.version;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { bids: [{ price: String(version) }], asks: [] };
    }),
  };
  let onMarket: (event: unknown) => void = () => undefined;
  const reader = {
    onMarket: (handler: typeof onMarket) => {
      onMarket = handler;
      return () => undefined;
    },
  };
  const server = {
    use: jest.fn(),
    sockets: { adapter: { rooms } },
    to: (room: string) => ({
      emit: (event: string, payload: Book) => {
        for (const socket of [...(rooms.get(room) ?? [])]) socket.emit(event, payload);
      },
    }),
    disconnectSockets: jest.fn(),
  };
  const gateway = new OrdersGateway(
    book as unknown as CommittedBook,
    { has: () => true } as unknown as InstrumentCatalog,
    reader as unknown as RealtimeStreamReader,
    { onStale: () => () => undefined } as unknown as ReplicaLagMonitor,
  );
  gateway.server = server as never;
  gateway.afterInit(server as never);
  return {
    gateway,
    state,
    rooms,
    socket: () => new FakeSocket(rooms),
    change: () => {
      state.version++;
      onMarket({ type: 'book.delta', payload: { instrument: 'ABC' } });
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('legacy subscriptions', () => {
  it('holds for any mix of subscribes, disconnects and book changes', async () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant('subscribe' as const), who: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ kind: fc.constant('disconnect' as const), who: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ kind: fc.constant('change' as const), who: fc.constant(0) }),
      fc.record({ kind: fc.constant('wait' as const), who: fc.integer({ min: 1, max: 120 }) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 40 }), async (ops) => {
        jest.useFakeTimers();
        const env = build();
        const sockets = Array.from({ length: 4 }, () => env.socket());
        // Версія книги на момент останньої підписки: після неї сокет має отримати не старішу.
        const subscribedAt = new Map<FakeSocket, number>();
        let subscribes = 0;
        let changes = 0;
        for (const { kind, who } of ops) {
          const socket = sockets[who % 4];
          if (kind === 'subscribe') {
            if (socket.connected) {
              subscribes++;
              subscribedAt.set(socket, env.state.version);
              void env.gateway.subscribe(socket as never, 'ABC');
            }
          } else if (kind === 'disconnect') socket.disconnect();
          else if (kind === 'change') {
            changes++;
            env.change();
          } else await jest.advanceTimersByTimeAsync(who);
        }
        await jest.advanceTimersByTimeAsync(2000);

        for (const socket of sockets) {
          // Книга одного сокета ніколи не відкочується до старішої версії.
          expect(socket.received).toEqual([...socket.received].sort((a, b) => a - b));
          const since = subscribedAt.get(socket);
          // Той, хто лишився підключеним, отримав книгу не старішу за свою підписку.
          if (socket.connected && since !== undefined)
            expect(Math.max(...socket.received, -1)).toBeGreaterThanOrEqual(since);
        }
        // Читань не більше, ніж викликів, що їх спричиняють, а за схлопування часто менше.
        expect(env.state.reads).toBeLessThanOrEqual(subscribes + changes);
        jest.useRealTimers();
      }),
      { numRuns: 150 },
    );
  });

  it('answers a thousand repeated subscribes of one socket with at most two reads', async () => {
    const env = build();
    const socket = env.socket();
    const calls = Array.from({ length: 1000 }, () => env.gateway.subscribe(socket as never, 'ABC'));
    await jest.advanceTimersByTimeAsync(500);
    await Promise.all(calls);
    expect(env.state.reads).toBeLessThanOrEqual(2);
    expect(socket.received).toHaveLength(1);
  });

  it('does not read the book for a batch whose sockets have all gone', async () => {
    const env = build();
    const first = env.socket();
    const second = env.socket();
    const firstCall = env.gateway.subscribe(first as never, 'ABC');
    await jest.advanceTimersByTimeAsync(10);
    // Читання для першого ще триває, друга пачка чекає в черзі.
    const secondCall = env.gateway.subscribe(second as never, 'ABC');
    second.disconnect();
    await jest.advanceTimersByTimeAsync(500);
    await Promise.all([firstCall, secondCall]);

    expect(env.state.reads).toBe(1);
    expect(first.received).toHaveLength(1);
    expect(second.received).toHaveLength(0);
  });

  it('does not accept a subscribe from a socket that has already gone', async () => {
    const env = build();
    const socket = env.socket();
    socket.disconnect();
    await env.gateway.subscribe(socket as never, 'ABC');
    await jest.advanceTimersByTimeAsync(500);
    expect(env.state.reads).toBe(0);
    expect(env.rooms.get('ABC')?.size ?? 0).toBe(0);
  });
});
