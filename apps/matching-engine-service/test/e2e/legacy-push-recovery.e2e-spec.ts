import { ServiceUnavailableException } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { CommittedBook } from '../../src/engine/committed-book';
import { waitFor } from '../helpers/wait-for';
import { engineApp } from './engine-app';

const { app, register, submit, url } = engineApp();
const sockets: Socket[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  sockets.splice(0).forEach((socket) => socket.disconnect());
});

interface Book {
  asks: { price: string }[];
}

/** Підписаний клієнт застарілого namespace з першою отриманою книгою. */
async function subscribed(): Promise<{ socket: Socket; books: Book[] }> {
  const socket = io(url(), { transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  const books: Book[] = [];
  socket.on('book', (book: Book) => books.push(book));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect_error', reject);
    socket.once('connect', () => socket.emit('subscribe', 'ABC'));
    socket.once('book', () => resolve());
  });
  return { socket, books };
}

const busy = () => new ServiceUnavailableException({ code: 'BOOK_BUSY' });

it('delivers the book after a failed push without another command', async () => {
  const owner = await register();
  const { books } = await subscribed();
  const book = app().get(CommittedBook);
  const original = book.read.bind(book);
  let calls = 0;
  jest.spyOn(book, 'read').mockImplementation(async (...args) => {
    if (++calls === 1) throw busy();
    return original(...args);
  });

  expect((await submit(owner, { price: 100 })).status).toBe(201);

  await waitFor(async () => books.at(-1)?.asks.length === 1, 5000);
  expect(calls).toBe(2);
}, 30000);

it('closes the connection when every retry fails, and a new client gets the book', async () => {
  const owner = await register();
  const { socket } = await subscribed();
  const read = jest.spyOn(app().get(CommittedBook), 'read').mockRejectedValue(busy());

  expect((await submit(owner, { price: 100 })).status).toBe(201);

  await waitFor(async () => !socket.connected, 8000);
  // Перша спроба і три повтори, далі клієнт сам перепідключається.
  expect(read).toHaveBeenCalledTimes(4);
  read.mockRestore();

  const again = await subscribed();
  expect(again.books.at(-1)?.asks.map(({ price }) => price)).toEqual(['100.00']);
}, 30000);
