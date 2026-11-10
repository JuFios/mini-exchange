import { CommittedBook } from '../../src/engine/committed-book';
import { OrdersGateway } from '../../src/orders/gateway/orders.gateway';
import { InstrumentCatalog } from '../../src/orders/instrument-catalog';
import { RealtimeStreamReader } from '../../src/realtime/realtime-stream-reader.service';
import { ReplicaLagMonitor } from '../../src/realtime/replica-lag.monitor';

type Book = { bids: { price: string }[]; asks: never[] };

/** Сокет-заглушка: фіксує книги, які йому надіслано, і не приймає нічого після розриву. */
export class FakeSocket {
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

/**
 * Legacy-шлюз із підміненою книгою: версія береться на початку читання, а книга надходить із
 * затримкою 50 мс, тож виглядає старішою. `fail` вирішує, чи читання завершиться помилкою.
 */
export function buildLegacyGateway(fail: () => boolean = () => false) {
  const rooms = new Map<string, Set<FakeSocket>>();
  const state = { version: 0, reads: 0, closedRooms: 0 };
  const book = {
    read: jest.fn(async () => {
      state.reads++;
      const version = state.version;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (fail()) throw new Error('BOOK_BUSY');
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
    in: (room: string) => ({
      disconnectSockets: () => {
        state.closedRooms++;
        for (const socket of [...(rooms.get(room) ?? [])]) socket.disconnect();
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
