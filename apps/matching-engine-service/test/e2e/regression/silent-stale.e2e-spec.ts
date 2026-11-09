import { io, Socket } from 'socket.io-client';
import { waitFor } from '../../helpers/wait-for';
import { engineApp } from '../engine-app';

const { register, submit, url } = engineApp();

interface Book {
  bids: { price: string; quantity: string; orders: number }[];
  asks: { price: string; quantity: string; orders: number }[];
}

it('keeps a connected starter client up to date instead of leaving it on a stale book', async () => {
  const owner = await register();
  const socket: Socket = io(url(), {
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  const books: Book[] = [];
  try {
    socket.on('book', (book: Book) => books.push(book));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect_error', reject);
      socket.once('connect', () => socket.emit('subscribe', 'ABC', () => undefined));
      socket.once('book', () => resolve());
    });
    expect(books.at(-1)).toEqual({ bids: [], asks: [] });

    for (const price of [100, 101, 102, 103, 104])
      expect((await submit(owner, { price })).status).toBe(201);

    // З'єднання живе, тож клієнт мав би побачити всі п'ять рівнів, а не порожню книгу.
    await waitFor(async () => books.at(-1)?.asks.length === 5, 3000);
    expect(socket.connected).toBe(true);
    expect(books.at(-1)?.asks.map(({ price }) => price)).toEqual([
      '100.00',
      '101.00',
      '102.00',
      '103.00',
      '104.00',
    ]);
    expect(JSON.stringify(books)).not.toMatch(/"(id|ownerId|userId)"\s*:/);
  } finally {
    socket.disconnect();
  }
});
