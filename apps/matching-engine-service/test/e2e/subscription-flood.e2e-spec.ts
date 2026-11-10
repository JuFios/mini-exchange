import { io, Socket } from 'socket.io-client';
import { CommittedBook } from '../../src/engine/committed-book';
import { waitFor } from '../helpers/wait-for';
import { connect } from '../helpers/websocket';
import { engineApp } from './engine-app';

const { app, register, submit, url } = engineApp();
const sockets: Socket[] = [];
const READ_MS = 100;
const FLOOD = 1000;

afterEach(() => {
  jest.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.disconnect());
});

/** Підміняє читання книги повільним і рахує його виклики. */
function slowReads() {
  const reads: string[] = [];
  jest.spyOn(app().get(CommittedBook), 'read').mockImplementation(async (instrument: string) => {
    reads.push(instrument);
    await new Promise((resolve) => setTimeout(resolve, READ_MS));
    return { instrument, seq: '0', bids: [], asks: [] };
  });
  return reads;
}

async function legacy(): Promise<Socket> {
  const socket = await connect(url(), '');
  sockets.push(socket);
  return socket;
}

// Успішна підписка нічого не підтверджує, окрім самої книги: чекаємо подію `book`.
const subscribeAndWait = (socket: Socket) =>
  new Promise<void>((resolve) => {
    socket.once('book', () => resolve());
    socket.emit('subscribe', 'ABC');
  });

const subscribeAcked = (socket: Socket) =>
  new Promise<unknown>((resolve) => socket.emit('subscribe', 'ABC', resolve));

describe('the legacy namespace under a flood of subscribe calls', () => {
  it('reads the book a bounded number of times for one socket', async () => {
    const reads = slowReads();
    const attacker = await legacy();
    for (let i = 0; i < FLOOD; i++) attacker.emit('subscribe', 'ABC');

    const probe = await legacy();
    const started = Date.now();
    await subscribeAndWait(probe);
    expect(Date.now() - started).toBeLessThan(1500);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(reads.length).toBeLessThanOrEqual(4);
  }, 30000);

  it('does not read the book for a socket that has already gone', async () => {
    const reads = slowReads();
    const attacker = await legacy();
    for (let i = 0; i < FLOOD; i++) attacker.emit('subscribe', 'ABC');
    await new Promise((resolve) => setTimeout(resolve, 50));
    attacker.disconnect();

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(reads.length).toBeLessThanOrEqual(2);
  }, 30000);

  it('does not delay the pushes that other clients wait for', async () => {
    const owner = await register();
    const watcher = await legacy();
    const books: unknown[] = [];
    watcher.on('book', (book: unknown) => books.push(book));
    await subscribeAndWait(watcher);
    const reads = slowReads();

    const attacker = await legacy();
    for (let i = 0; i < FLOOD; i++) attacker.emit('subscribe', 'ABC');
    const before = books.length;
    expect((await submit(owner, { price: 100 })).status).toBe(201);

    await waitFor(async () => books.length > before, 1500);
    expect(reads.length).toBeLessThan(20);
  }, 30000);

  it('serves sockets that subscribe together with a shared read', async () => {
    const reads = slowReads();
    const crowd = await Promise.all(Array.from({ length: 20 }, legacy));
    const books = crowd.map((socket) => {
      const received: unknown[] = [];
      socket.on('book', (book: unknown) => received.push(book));
      return received;
    });
    await Promise.all(crowd.map((socket) => socket.emit('subscribe', 'ABC')));
    await waitFor(async () => books.every((received) => received.length === 1), 5000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(books.every((received) => received.length === 1)).toBe(true);
    expect(reads.length).toBeLessThanOrEqual(3);
  }, 30000);

  it('tells every waiting socket when the shared read fails', async () => {
    jest.spyOn(app().get(CommittedBook), 'read').mockRejectedValue(new Error('PG is down'));
    const crowd = await Promise.all(Array.from({ length: 5 }, legacy));
    const acks = await Promise.all(crowd.map(subscribeAcked));
    expect(acks).toEqual(Array(5).fill({ ok: false, error: 'Книга тимчасово недоступна' }));
  }, 30000);
});

describe('the market namespace under a flood of book.subscribe calls', () => {
  it('queues a bounded number of snapshot reads per socket and refuses the rest', async () => {
    const reads = slowReads();
    const attacker = io(`${url()}/market`, { transports: ['websocket'], reconnection: false });
    sockets.push(attacker);
    await new Promise<void>((resolve) => attacker.once('connect', () => resolve()));

    const acks: { ok: boolean; error?: string }[] = [];
    for (let i = 0; i < FLOOD; i++)
      attacker.emit('book.subscribe', { instrument: 'ABC' }, (ack: (typeof acks)[number]) =>
        acks.push(ack),
      );

    const probe = await connect(url(), '/market');
    sockets.push(probe);
    const started = Date.now();
    const ack = await new Promise<{ ok: boolean }>((resolve) =>
      probe.emit('book.subscribe', { instrument: 'ABC' }, resolve),
    );
    expect(ack.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);

    await waitFor(async () => acks.length === FLOOD, 10000);
    // До чотирьох підписок у черзі; решта відхиляється одразу, без читання.
    expect(acks.filter(({ ok }) => ok).length).toBeLessThanOrEqual(4);
    expect(acks.filter(({ error }) => error === 'TOO_MANY_REQUESTS').length).toBeGreaterThan(
      FLOOD - 10,
    );
    expect(reads.length).toBeLessThanOrEqual(5);
  }, 30000);
});
