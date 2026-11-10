import { io, Socket } from 'socket.io-client';
import { CommittedBook } from '../../src/engine/committed-book';
import { waitFor } from '../helpers/wait-for';
import { engineApp } from './engine-app';

const { app, register, submit, url } = engineApp();

interface Book {
  bids: unknown[];
  asks: { price: string }[];
}

it('never replaces a newer book with the result of an older, slower read', async () => {
  const owner = await register();
  const socket: Socket = io(url(), { transports: ['websocket'], reconnection: false });
  const books: Book[] = [];
  const book = app().get(CommittedBook);
  const original = book.read.bind(book);
  let reads = 0;
  try {
    socket.on('book', (pushed: Book) => books.push(pushed));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.once('connect', () => socket.emit('subscribe', 'ABC', () => undefined));
      socket.once('book', () => resolve());
    });

    // Перше читання після підписки повертає свій результат із запізненням.
    const read = jest.spyOn(book, 'read').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (++reads === 1) await new Promise((resolve) => setTimeout(resolve, 800));
      return result;
    });
    try {
      expect((await submit(owner, { price: 100 })).status).toBe(201);
      await waitFor(async () => reads >= 1, 3000);
      expect((await submit(owner, { price: 101 })).status).toBe(201);

      await waitFor(async () => books.at(-1)?.asks.length === 2, 5000);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(books.at(-1)?.asks.map(({ price }) => price)).toEqual(['100.00', '101.00']);
    } finally {
      read.mockRestore();
    }
  } finally {
    socket.disconnect();
  }
}, 30000);
