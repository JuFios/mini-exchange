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
    instrument: 'ABC',
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
