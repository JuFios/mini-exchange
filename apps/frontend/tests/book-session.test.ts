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
  private cancelAck?: () => void;
  constructor(private readonly clock: Clock) {}
  on(event: string, handler: (...args: never[]) => void) {
    this.handlers.set(event, handler);
  }
  timeout(ms: number) {
    return {
      emit: (event: string, ...args: unknown[]) => {
        const [body, ack] = args as [unknown, (error: Error | null, reply?: unknown) => void];
        const cancel = () => this.clock.clearTimeout(timer);
        const complete = (error: Error | null, reply?: unknown) => {
          cancel();
          if (this.cancelAck === cancel) this.cancelAck = undefined;
          ack(error, reply);
        };
        const timer = this.clock.setTimeout(() => complete(new Error('Ack timed out')), ms);
        this.cancelAck = cancel;
        this.emitted.push({ event, args: [body, (reply: unknown) => complete(null, reply)] });
      },
    };
  }
  connect() {
    this.connects++;
  }
  disconnect() {
    this.cancelAck?.();
    this.disconnects++;
  }
  fire(event: string, ...args: unknown[]) {
    if (event === 'disconnect' || event === 'connect_error') this.cancelAck?.();
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
  get awaitingAck() {
    return this.cancelAck !== undefined;
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
  const socket = new FakeSocket(clock);
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

  it('ignores the previous ack once its deadline has started another attempt', () => {
    const { socket, clock, statuses, books } = start();
    socket.fire('connect');
    const late = socket.emitted[0].args[1] as (reply: unknown) => void;
    clock.tick(SUBSCRIBE_TIMEOUT_MS + RETRY_MIN_MS);
    assert.equal(socket.subscribes, 2);
    late({ ok: true, snapshot: { ...BOOK, seq: '99' } });
    assert.equal(statuses.at(-1), 'loading');
    assert.equal(books.length, 0);
    socket.accept(BOOK);
    assert.equal(books.at(-1)?.seq, '10');
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

describe('recovery before the first snapshot on a connection', () => {
  function refuse(socket: FakeSocket) {
    const subscription = socket.emitted.at(-1);
    assert.ok(subscription);
    assert.equal(subscription.event, 'book.subscribe');
    (subscription.args[1] as (reply: unknown) => void)({ ok: false, error: 'BOOK_BUSY' });
  }

  function exhaustAttempts(socket: FakeSocket, clock: ManualClock) {
    for (const delay of [250, 500, 1000, 2000, 2000]) {
      refuse(socket);
      clock.tick(delay);
    }
    refuse(socket);
  }

  it('retries at a bounded rate without a heartbeat and applies deltas during the retry', () => {
    const { socket, clock, statuses, books, snapshots } = start();
    socket.fire('connect');
    exhaustAttempts(socket, clock);
    assert.equal(socket.subscribes, 6);
    assert.equal(statuses.at(-1), 'error');

    clock.tick(9999);
    assert.equal(socket.subscribes, 6);
    clock.tick(1);
    assert.equal(socket.subscribes, 7);
    refuse(socket);
    assert.equal(statuses.at(-1), 'error');

    clock.tick(10_000);
    assert.equal(socket.subscribes, 8);
    socket.fire('book.delta', { instrument: 'ABC', seq: '11', changes: [] });
    socket.accept(BOOK);
    assert.equal(statuses.at(-1), 'live');
    assert.equal(books.at(-1)?.seq, '11');
    assert.equal(snapshots.length, 1);
    clock.tick(10_000);
    assert.equal(socket.subscribes, 8);
  });

  it('retries on a new connection even when the previous book is still visible', () => {
    const { socket, clock, statuses, books } = start();
    socket.fire('connect');
    socket.accept(BOOK);
    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    exhaustAttempts(socket, clock);
    assert.equal(statuses.at(-1), 'error');
    assert.equal(books.at(-1)?.seq, '10');

    clock.tick(10_000);
    assert.equal(socket.subscribes, 8);
    socket.accept({ ...BOOK, seq: '11' });
    assert.equal(statuses.at(-1), 'live');
    assert.equal(books.at(-1)?.seq, '11');
  });

  it('clears the pending retry when the socket disconnects or the session stops', () => {
    for (const end of ['disconnect', 'stop']) {
      const { socket, clock, stop } = start();
      socket.fire('connect');
      exhaustAttempts(socket, clock);
      assert.equal(clock.pending, 1);
      if (end === 'disconnect') socket.fire('disconnect', 'transport close');
      else stop();
      assert.equal(clock.pending, 0);
      clock.tick(20_000);
      assert.equal(socket.subscribes, 6);
    }
  });

  it('keeps one pending acknowledgement or retry through repeated transport timeouts', () => {
    const { socket, clock, statuses, books, stop } = start();
    socket.fire('connect');
    exhaustAttempts(socket, clock);
    for (let attempt = 0; attempt < 30; attempt++) {
      const before = socket.subscribes;
      clock.tick(9999);
      assert.equal(socket.subscribes, before);
      clock.tick(1);
      assert.equal(socket.subscribes, before + 1);
      assert.equal(clock.pending, 1);
      clock.tick(SUBSCRIBE_TIMEOUT_MS);
      assert.equal(statuses.at(-1), 'error');
      assert.equal(clock.pending, 1);
      assert.equal(books.length, 0);
    }
    stop();
    assert.equal(clock.pending, 0);
  });

  it('rejects an older recovery snapshot and keeps retrying until the visible sequence is reached', () => {
    const { socket, clock, statuses, books } = start();
    socket.fire('connect');
    socket.accept(BOOK);
    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    exhaustAttempts(socket, clock);
    clock.tick(10_000);
    socket.accept({ ...BOOK, seq: '9' });
    assert.equal(statuses.at(-1), 'error');
    assert.equal(books.at(-1)?.seq, '10');
    clock.tick(10_000);
    socket.accept({ ...BOOK, seq: '11' });
    assert.equal(statuses.at(-1), 'live');
    assert.deepEqual(
      books.map(({ seq }) => seq),
      ['10', '11'],
    );
  });

  it('coalesces resync signals during a slow retry before publishing the recovered book', () => {
    const { socket, clock, statuses, books, snapshots } = start();
    socket.fire('connect');
    exhaustAttempts(socket, clock);
    clock.tick(10_000);
    for (let signal = 0; signal < 20; signal++) {
      socket.fire('book.resync', { instrument: 'ABC' });
      socket.fire('book.heartbeat', { instrument: 'ABC', seq: '11' });
    }
    assert.equal(socket.subscribes, 7);
    socket.accept(BOOK);
    assert.equal(socket.subscribes, 8);
    assert.equal(statuses.at(-1), 'loading');
    assert.equal(books.length, 0);
    assert.equal(snapshots.length, 0);
    socket.accept({ ...BOOK, seq: '11' });
    assert.equal(statuses.at(-1), 'live');
    assert.equal(snapshots.length, 1);
    assert.equal(books.at(-1)?.seq, '11');
  });

  it('isolates retries and cleanup between simultaneous sessions', () => {
    const first = start();
    const second = start();
    first.socket.fire('connect');
    second.socket.fire('connect');
    exhaustAttempts(first.socket, first.clock);
    exhaustAttempts(second.socket, second.clock);
    first.stop();
    second.clock.tick(10_000);
    second.socket.accept(BOOK);
    first.clock.tick(20_000);
    assert.equal(first.socket.subscribes, 6);
    assert.equal(first.clock.pending, 0);
    assert.equal(second.socket.subscribes, 7);
    assert.equal(second.statuses.at(-1), 'live');
    second.stop();
    assert.equal(second.clock.pending, 0);
  });

  it('ignores an in-flight retry acknowledgement after disconnect, reconnect or stop', () => {
    for (const ending of ['disconnect', 'reconnect', 'stop']) {
      const { socket, clock, statuses, books, stop } = start();
      socket.fire('connect');
      exhaustAttempts(socket, clock);
      clock.tick(10_000);
      const late = socket.emitted.at(-1)!.args[1] as (reply: unknown) => void;
      if (ending === 'stop') stop();
      else {
        socket.fire('disconnect', 'transport close');
        if (ending === 'reconnect') socket.fire('connect');
      }
      const pending = clock.pending;
      late({ ok: true, snapshot: { ...BOOK, seq: '999' } });
      late({ ok: false, error: 'BOOK_BUSY' });
      assert.equal(books.length, 0);
      assert.equal(clock.pending, pending);
      if (ending === 'reconnect') {
        socket.accept({ ...BOOK, seq: '11' });
        assert.equal(statuses.at(-1), 'live');
        assert.equal(books.at(-1)?.seq, '11');
      }
      stop();
      assert.equal(clock.pending, 0);
    }
  });

  it('preserves recovery and cleanup invariants across event orderings', () => {
    const events = ['advance', 'heartbeat', 'resync', 'delta', 'lateReply', 'end'] as const;
    type Event = (typeof events)[number];
    function* permutations(remaining: readonly Event[]): Generator<Event[]> {
      if (remaining.length === 0) yield [];
      for (const event of remaining) {
        for (const rest of permutations(remaining.filter((value) => value !== event))) {
          yield [event, ...rest];
        }
      }
    }

    let checked = 0;
    for (const phase of ['waiting', 'subscribing']) {
      for (const ending of ['stop', 'disconnect', 'reconnect']) {
        for (const ordering of permutations(events)) {
          const { socket, clock, statuses, books, stop } = start();
          socket.fire('connect');
          exhaustAttempts(socket, clock);
          const expired = socket.emitted.at(-1)!.args[1] as (reply: unknown) => void;
          if (phase === 'subscribing') clock.tick(10_000);
          let ended = false;
          for (const event of ordering) {
            const before = socket.subscribes;
            switch (event) {
              case 'advance':
                clock.tick(10_000);
                break;
              case 'heartbeat':
                socket.fire('book.heartbeat', { instrument: 'ABC', seq: '11' });
                break;
              case 'resync':
                socket.fire('book.resync', { instrument: 'ABC' });
                break;
              case 'delta':
                socket.fire('book.delta', { instrument: 'ABC', seq: '11', changes: [] });
                break;
              case 'lateReply':
                expired({ ok: true, snapshot: { ...BOOK, seq: '999' } });
                expired({ ok: false });
                break;
              case 'end':
                if (ending === 'stop') stop();
                else {
                  socket.fire('disconnect', 'transport close');
                  if (ending === 'reconnect') socket.fire('connect');
                }
                ended = true;
                break;
            }
            assert.equal(books.length, 0, ordering.join(','));
            assert.ok(clock.pending <= 1, ordering.join(','));
            if (ended && ending !== 'reconnect') {
              assert.equal(socket.subscribes, before);
              assert.equal(clock.pending, 0);
            }
          }
          if (ending === 'reconnect') {
            if (!socket.awaitingAck) clock.tick(RETRY_MAX_MS);
            assert.equal(socket.awaitingAck, true);
            const before = socket.subscribes;
            socket.accept({ ...BOOK, seq: '20' });
            assert.ok(socket.subscribes <= before + 1, ordering.join(','));
            if (socket.subscribes === before + 1) {
              assert.equal(books.length, 0);
              assert.equal(statuses.at(-1), 'loading');
              socket.accept({ ...BOOK, seq: '20' });
            }
            assert.equal(statuses.at(-1), 'live', ordering.join(','));
            assert.equal(books.at(-1)?.seq, '20');
          }
          stop();
          assert.equal(clock.pending, 0);
          checked++;
        }
      }
    }
    assert.equal(checked, 4320);
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

  it('retains the visible book after five retries and recovers when heartbeat returns', () => {
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

    state.heartbeat(14);
    assert.equal(count(), 8);
    assert.equal(state.statuses.at(-1), 'stale');
    state.accept(14, [level(101)]);
    assert.equal(state.statuses.at(-1), 'live');
    assert.deepEqual(state.books.at(-1)?.asks, [level(101)]);
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
