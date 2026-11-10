import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BookState,
  BookStatus,
  Clock,
  RETRY_MAX_MS,
  RETRY_MIN_MS,
  SocketLike,
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
    (this.handlers.get(event) as (...a: unknown[]) => void)(...args);
  }
  /** Скільки разів сесія надіслала `subscribe`. */
  get subscribes() {
    return this.emitted.filter(({ event }) => event === 'subscribe').length;
  }
}

const BOOK: BookState = { bids: [{ price: '99', quantity: '1' }], asks: [] };

function start() {
  const socket = new FakeSocket();
  const clock = new ManualClock();
  const statuses: BookStatus[] = [];
  const books: BookState[] = [];
  const stop = startBookSession(
    socket,
    'ABC',
    { onStatus: (status) => statuses.push(status), onBook: (book) => books.push(book) },
    clock,
  );
  return { socket, clock, statuses, books, stop };
}

describe('the book page connection', () => {
  it('does not call the book live before a snapshot has arrived', () => {
    const { socket, statuses } = start();
    socket.fire('connect');
    assert.equal(statuses.includes('live'), false);
    socket.fire('book', BOOK);
    assert.equal(statuses.at(-1), 'live');
  });

  it('does not show a reconnected page as live until the new snapshot', () => {
    const { socket, statuses } = start();
    socket.fire('connect');
    socket.fire('book', BOOK);
    socket.fire('disconnect', 'transport close');
    assert.equal(statuses.at(-1), 'disconnected');

    socket.fire('connect');
    assert.notEqual(statuses.at(-1), 'live');
    socket.fire('book', BOOK);
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

  it('stops retrying the subscription once the book arrives', () => {
    const { socket, clock } = start();
    socket.fire('connect');
    clock.tick(1000);
    socket.fire('book', BOOK);
    const before = socket.subscribes;
    clock.tick(60_000);
    assert.equal(socket.subscribes, before);
    assert.equal(clock.pending, 0);
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
    socket.fire('book', BOOK);
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
