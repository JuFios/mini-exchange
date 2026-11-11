import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { io } from 'socket.io-client';
import {
  BookState,
  BookStatus,
  Clock,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  SocketLike,
  SUBSCRIBE_TIMEOUT_MS,
  startBookSession,
} from '../lib/book-session';

/** Годинник, яким тест рухає сам: час іде лише через `tick`. */
class ManualClock implements Clock {
  private now = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; handler: () => void }>();
  setTimeout(handler: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, handler });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  tick(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].handler();
    }
    this.now = end;
  }
  get pending() {
    return this.timers.size;
  }
}

/** Сокет-заглушка: події викликає тест, а виклики сесії записуються. */
class FakeSocket implements SocketLike {
  active = false;
  handlers = new Map<string, (...args: never[]) => void>();
  emitted: { event: string; args: unknown[] }[] = [];
  connects = 0;
  disconnects = 0;
  on(event: string, handler: (...args: never[]) => void) {
    this.handlers.set(event, handler);
  }
  emit(event: string, ...args: unknown[]) {
    this.emitted.push({ event, args });
  }
  connect() {
    this.connects++;
  }
  disconnect() {
    this.disconnects++;
  }
  fire(event: string, ...args: unknown[]) {
    (this.handlers.get(event) as ((...a: unknown[]) => void) | undefined)?.(...args);
  }
  accept(snapshot: BookState) {
    const subscription = this.emitted.filter(({ event }) => event === 'book.subscribe').at(-1);
    assert.ok(subscription);
    (subscription.args[1] as (reply: unknown) => void)({ ok: true, snapshot });
  }
  /** Скільки разів сесія надіслала `subscribe`. */
  get subscribes() {
    return this.emitted.filter(({ event }) => event === 'book.subscribe').length;
  }
}

const BOOK: BookState = {
  instrument: 'ABC',
  seq: '10',
  bids: [{ price: '99', quantity: '1', orders: 1 }],
  asks: [],
};

function start() {
  const clock = new ManualClock();
  const socket = new FakeSocket();
  const statuses: BookStatus[] = [];
  const books: BookState[] = [];
  const snapshots: BookState[] = [];
  const stop = startBookSession(
    socket,
    'ABC',
    {
      onStatus: (status) => statuses.push(status),
      onBook: (book) => books.push(book),
      onSnapshot: () => snapshots.push(books.at(-1)!),
    },
    clock,
  );
  return { socket, clock, statuses, books, snapshots, stop };
}

describe('the book page connection', () => {
  it('does not call the book live before a snapshot has arrived', () => {
    const { socket, statuses } = start();
    socket.fire('connect');
    assert.equal(statuses.includes('live'), false);
    socket.accept(BOOK);
    assert.equal(statuses.at(-1), 'live');
  });

  it('does not show a reconnected page as live until the new snapshot', () => {
    const { socket, statuses } = start();
    socket.fire('connect');
    socket.accept(BOOK);
    socket.fire('disconnect', 'transport close');
    assert.equal(statuses.at(-1), 'reconnecting');

    socket.fire('connect');
    assert.notEqual(statuses.at(-1), 'live');
    socket.accept(BOOK);
    assert.equal(statuses.at(-1), 'live');
  });

  it('subscribes again when no snapshot arrives', () => {
    const { socket, clock } = start();
    socket.fire('connect');
    assert.equal(socket.subscribes, 1);
    clock.tick(10_000);
    assert.ok(socket.subscribes >= 2, `subscribes: ${socket.subscribes}`);
  });

  it('subscribes again, and later, after the server refused the subscription', () => {
    const { socket, clock } = start();
    socket.fire('connect');
    const ack = socket.emitted[0].args.find((arg) => typeof arg === 'function') as (
      reply: unknown,
    ) => void;
    assert.equal(typeof ack, 'function');
    ack({ ok: false, error: 'Книга тимчасово недоступна' });
    clock.tick(RETRY_MIN_MS);
    assert.equal(socket.subscribes, 2);
  });

  it('starts the resubscribe delay over once a book has arrived', () => {
    const { socket, clock } = start();
    const refuse = () => {
      const call = socket.emitted.filter(({ event }) => event === 'book.subscribe').at(-1)!;
      (call.args.find((arg) => typeof arg === 'function') as (reply: unknown) => void)({
        ok: false,
      });
    };
    socket.fire('connect');
    refuse();
    clock.tick(RETRY_MIN_MS);
    refuse();
    clock.tick(RETRY_MIN_MS * 2);
    assert.equal(socket.subscribes, 3);

    socket.accept(BOOK);
    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    const before = socket.subscribes;
    refuse();
    clock.tick(RETRY_MIN_MS);
    assert.equal(socket.subscribes, before + 1);
  });

  it('stops retrying the subscription once the book arrives', () => {
    const { socket, clock } = start();
    socket.fire('connect');
    clock.tick(1000);
    socket.accept(BOOK);
    const before = socket.subscribes;
    clock.tick(60_000);
    assert.equal(socket.subscribes, before);
    assert.equal(clock.pending, 0);
  });

  it('lets Socket.IO release a snapshot ack and its packet at the deadline', ({ mock }) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const socket = io('http://127.0.0.1/market', { autoConnect: false, forceNew: true });
    const stop = startBookSession(socket, 'ABC', { onStatus() {}, onBook() {} });
    try {
      for (const connected of socket.listeners('connect')) connected();
      assert.equal(socket.sendBuffer.length, 1);
      mock.timers.tick(SUBSCRIBE_TIMEOUT_MS);
      assert.equal(socket.sendBuffer.length, 0);
      assert.equal(Object.keys((socket as unknown as { acks: object }).acks).length, 0);
    } finally {
      stop();
    }
  });

  it('stops retrying the subscription when the connection drops', () => {
    const { socket, clock } = start();
    socket.fire('connect');
    socket.fire('disconnect', 'transport close');
    const before = socket.subscribes;
    clock.tick(60_000);
    assert.equal(socket.subscribes, before);
  });

  it('keeps the retry delay growing until a book arrives', () => {
    const { socket, clock } = start();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const before = socket.connects;
      socket.fire('disconnect', 'io server disconnect');
      let waited = 0;
      while (socket.connects === before && waited < 10_000) {
        clock.tick(50);
        waited += 50;
      }
      delays.push(waited);
    }
    assert.deepEqual(delays, [250, 500, 1000, 2000, 2000, 2000]);
    assert.equal(RETRY_MAX_MS, 2000);
    socket.fire('connect');
    socket.accept(BOOK);
    const before = socket.connects;
    socket.fire('disconnect', 'io server disconnect');
    clock.tick(RETRY_MIN_MS);
    assert.equal(socket.connects, before + 1);
  });

  it('reconnects after a refused handshake only when Socket.IO will not', () => {
    const { socket, clock } = start();
    socket.active = true;
    socket.fire('connect_error');
    clock.tick(5000);
    assert.equal(socket.connects, 0);
    socket.active = false;
    socket.fire('connect_error');
    clock.tick(RETRY_MIN_MS);
    assert.equal(socket.connects, 1);
  });

  it('leaves no timer behind once stopped', () => {
    const { socket, clock, stop } = start();
    socket.fire('connect');
    socket.fire('disconnect', 'io server disconnect');
    stop();
    assert.equal(socket.disconnects, 1);
    assert.equal(clock.pending, 0);
  });
});

const snapshot = (seq: number, asks: BookState['asks'] = []) => ({
  instrument: 'ABC',
  seq: String(seq),
  bids: [],
  asks,
});
const level = (price: number, quantity = '1') => ({
  price: price.toFixed(2),
  quantity,
  orders: 1,
});
const change = (price: number, quantity = '1') => ({
  ...level(price, quantity),
  side: 'ask',
});

function market(seq: number, asks?: BookState['asks']) {
  const session = start();
  const { socket } = session;
  const ack = (reply: unknown) => {
    const subscription = socket.emitted.filter(({ event }) => event === 'book.subscribe').at(-1);
    assert.ok(subscription);
    (subscription.args[1] as (reply: unknown) => void)(reply);
  };
  const accept = (next: number, rows?: BookState['asks']) =>
    ack({ ok: true, snapshot: snapshot(next, rows) });
  const delta = (next: number, changes: unknown[] = []) =>
    socket.fire('book.delta', { instrument: 'ABC', seq: String(next), changes });
  const heartbeat = (next: number) =>
    socket.fire('book.heartbeat', { instrument: 'ABC', seq: String(next) });
  socket.fire('connect');
  accept(seq, asks);
  return { ...session, ack, accept, delta, heartbeat };
}

describe('market book synchronization', () => {
  it('applies consecutive deltas to the snapshot', () => {
    const state = market(10, [level(100)]);
    state.delta(11, [change(100, '2')]);
    state.delta(12, [change(101)]);
    assert.equal(state.statuses.at(-1), 'live');
    assert.deepEqual(state.books.at(-1)?.asks, [level(100, '2'), level(101)]);
  });

  it('keeps the best fifty levels after each delta', () => {
    const state = market(
      10,
      Array.from({ length: 50 }, (_, i) => level(i + 1)),
    );
    state.delta(11, [change(1, '0'), change(51)]);
    assert.equal(state.books.at(-1)?.asks.length, 50);
    assert.equal(state.books.at(-1)?.asks[0].price, '2.00');
    assert.equal(state.books.at(-1)?.asks.at(-1)?.price, '51.00');
    state.delta(12, [change(52)]);
    assert.equal(state.books.at(-1)?.asks.length, 50);
    assert.equal(state.books.at(-1)?.asks.at(-1)?.price, '51.00');
  });

  it('requests one snapshot for a sequence gap', () => {
    const state = market(10);
    state.delta(13, [change(13)]);
    assert.equal(state.statuses.at(-1), 'stale');
    assert.equal(state.socket.emitted.filter(({ event }) => event === 'book.subscribe').length, 2);
    state.accept(12);
    assert.equal(state.books.at(-1)?.asks[0].price, '13.00');
  });

  it('refreshes trade history on a market gap even when the book sequence is current', () => {
    const state = market(10);
    state.delta(11);
    state.heartbeat(11);
    state.socket.fire('book.resync', { instrument: 'XYZ' });
    assert.equal(state.socket.subscribes, 1);
    state.socket.fire('book.resync', { instrument: 'ABC' });
    assert.equal(state.statuses.at(-1), 'stale');
    state.accept(11);
    assert.deepEqual(
      state.snapshots.map(({ seq }) => seq),
      ['10', '11'],
    );
  });

  it('coalesces gaps during recovery and reads after the last gap', () => {
    const state = market(10);
    for (let gap = 0; gap < 3; gap++) state.socket.fire('book.resync', { instrument: 'ABC' });
    assert.equal(state.socket.subscribes, 2);
    state.accept(10);
    assert.equal(state.socket.subscribes, 3);
    assert.equal(state.statuses.at(-1), 'stale');
    assert.equal(state.snapshots.length, 1);
    state.accept(11);
    assert.equal(state.statuses.at(-1), 'live');
    assert.deepEqual(
      state.snapshots.map(({ seq }) => seq),
      ['10', '11'],
    );
  });

  it('marks a silent socket stale and waits for a fresh snapshot after heartbeat returns', () => {
    const state = market(10);
    state.clock.tick(7999);
    assert.equal(state.statuses.at(-1), 'live');
    state.clock.tick(1);
    assert.equal(state.statuses.at(-1), 'stale');
    assert.equal(state.socket.subscribes, 1);
    state.delta(11, [change(100)]);
    state.heartbeat(11);
    state.heartbeat(11);
    assert.equal(state.statuses.at(-1), 'stale');
    assert.equal(state.socket.subscribes, 2);
    state.accept(11, [level(100)]);
    assert.equal(state.statuses.at(-1), 'live');
    state.stop();
    assert.equal(state.clock.pending, 0);
  });

  it('renews freshness on valid heartbeats for the current instrument', () => {
    const state = market(10);
    for (let beat = 0; beat < 5; beat++) {
      state.clock.tick(2000);
      state.heartbeat(10);
    }
    assert.deepEqual(state.statuses, ['loading', 'live']);
    state.clock.tick(7999);
    state.socket.fire('book.heartbeat', { instrument: 'XYZ', seq: '10' });
    state.clock.tick(1);
    assert.equal(state.statuses.at(-1), 'stale');
  });

  it('retains the visible book after five snapshot retries', () => {
    const state = market(10, [level(100)]);
    const visible = state.books.at(-1);
    const count = () =>
      state.socket.emitted.filter(({ event }) => event === 'book.subscribe').length;
    state.delta(13);
    for (const delay of [250, 500, 1000, 2000, 2000]) {
      const before = count();
      state.ack({ ok: false, error: 'BOOK_BUSY' });
      state.clock.tick(delay - 1);
      assert.equal(count(), before);
      state.clock.tick(1);
      assert.equal(count(), before + 1);
    }
    state.ack({ ok: false, error: 'BOOK_BUSY' });
    state.clock.tick(20_000);
    assert.equal(count(), 7);
    assert.equal(state.statuses.at(-1), 'error');
    assert.equal(state.books.at(-1), visible);
  });

  it('replays buffered deltas after the recovery snapshot', () => {
    const state = market(10);
    state.delta(13, [change(13)]);
    state.delta(14, [change(14)]);
    state.accept(12);
    assert.equal(state.statuses.at(-1), 'live');
    assert.deepEqual(state.books.at(-1)?.asks, [level(13), level(14)]);
    assert.equal((state.books.at(-1) as { seq?: string }).seq, '14');
  });

  it('ignores deltas at or behind the applied sequence', () => {
    const state = market(14);
    const previous = state.books.length;
    state.delta(12, [change(12)]);
    state.delta(14, [change(14)]);
    assert.equal(state.books.length, previous);
    assert.equal(state.statuses.at(-1), 'live');
  });

  it('resynchronizes if the previous heartbeat stays ahead', () => {
    const state = market(14);
    state.heartbeat(15);
    assert.equal(state.statuses.at(-1), 'live');
    state.heartbeat(15);
    assert.equal(state.statuses.at(-1), 'stale');
    assert.equal(state.socket.emitted.filter(({ event }) => event === 'book.subscribe').length, 2);
  });

  it('stays live while each prior heartbeat catches up', () => {
    const state = market(14);
    state.heartbeat(15);
    state.delta(15);
    state.heartbeat(16);
    state.delta(16);
    state.heartbeat(17);
    assert.deepEqual(state.statuses, ['loading', 'live']);
    assert.equal(state.socket.emitted.filter(({ event }) => event === 'book.subscribe').length, 1);
  });

  it('keeps the previous snapshot throughout reconnect', () => {
    const state = market(10, [level(100)]);
    const visible = state.books.at(-1);
    state.socket.fire('disconnect', 'transport close');
    state.socket.fire('connect');
    assert.deepEqual(state.statuses.slice(-2), ['reconnecting', 'loading']);
    assert.equal(state.books.at(-1), visible);
    state.accept(11, [level(101)]);
    assert.equal(state.statuses.at(-1), 'live');
    assert.deepEqual(state.books.at(-1)?.asks, [level(101)]);
  });
});
