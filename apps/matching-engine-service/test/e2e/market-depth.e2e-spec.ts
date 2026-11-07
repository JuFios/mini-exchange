import { io } from 'socket.io-client';
import { engineApp } from './engine-app';

const { register, request, submit, url } = engineApp();

it('exposes the best aggregated bid and ask through the public market route', async () => {
  const owner = await register();
  for (const price of [97, 98]) {
    expect((await submit(owner, { side: 'buy', price })).status).toBe(201);
  }
  for (const price of [102, 101]) {
    expect((await submit(owner, { price })).status).toBe(201);
  }

  const response = await request('/instruments/ABC/book?depth=1');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    instrument: 'ABC', seq: '4',
    bids: [{ price: '98.00', quantity: '1.00000000', orders: 1 }],
    asks: [{ price: '101.00', quantity: '1.00000000', orders: 1 }],
  });
});

it('sends only aggregated levels to an unauthenticated WebSocket subscriber', async () => {
  const owner = await register();
  expect((await submit(owner, { quantity: '0.1' })).status).toBe(201);
  expect((await submit(owner, { quantity: '0.2' })).status).toBe(201);

  const socket = io(url(), { transports: ['websocket'], reconnection: false, timeout: 3000 });
  try {
    const book = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No book event received')), 5000);
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('book', (snapshot: unknown) => {
        clearTimeout(timer);
        resolve(snapshot);
      });
      socket.emit('subscribe', 'ABC');
    });
    expect(book).toEqual({
      bids: [],
      asks: [{ price: '100.00', quantity: '0.30000000', orders: 2 }],
    });
  } finally {
    socket.disconnect();
  }
});

it.each(['UNKNOWN', '', 42, ['ABC'], { symbol: 'ABC' }])(
  'rejects a WebSocket subscription to %j without joining a room or sending a book',
  async (instrument) => {
    const socket = io(url(), { transports: ['websocket'], reconnection: false, timeout: 3000 });
    try {
      let bookReceived = false;
      socket.on('book', () => { bookReceived = true; });
      const ack = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No acknowledgement received')), 5000);
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once('connect', () => {
          socket.emit('subscribe', instrument, (response: unknown) => {
            clearTimeout(timer);
            resolve(response);
          });
        });
      });
      expect(ack).toEqual({ ok: false, error: 'Невідомий інструмент' });
      expect(bookReceived).toBe(false);
    } finally {
      socket.disconnect();
    }
  },
);

it('lists the configured instruments and their exact order limits without a JWT', async () => {
  const response = await request('/instruments');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(['ABC', 'XYZ'].map((symbol) => ({
    symbol,
    baseAsset: symbol,
    quoteAsset: 'USD',
    tickSize: '0.01',
    lotSize: '0.00000001',
    minQty: '0.00000001',
    maxQty: '1000000.00000000',
    maxPrice: '1000000.00',
  })));
});

it.each([
  '/instruments/UNKNOWN/book',
  '/orders/book',
  '/orders/book?instrument=ABC&instrument=XYZ',
  '/instruments/ABC/book?depth=0',
  '/instruments/ABC/book?depth=51',
  '/instruments/ABC/book?depth=1&depth=2',
])('rejects invalid public book queries (%s)', async (path) => {
  expect((await request(path)).status).toBe(400);
});
