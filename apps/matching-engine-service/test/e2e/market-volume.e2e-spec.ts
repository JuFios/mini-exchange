import { io } from 'socket.io-client';
import { engineApp } from './engine-app';
const api = engineApp();

it('returns exact price-level volumes beyond the precision of an individual order over REST and WebSocket', async () => {
  await api.restart({ ENGINE_WORKER_ENABLED: false });
  const token = await api.register();
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  await api.database().query(
    `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,priority_seq,created_at)
    SELECT $1,'ABC','sell',100,1000000,1000000,'open',i,now() FROM generate_series(1,10000) i`,
    [userId],
  );
  const expected = {
    bids: [],
    asks: [{ price: '100.00', quantity: '10000000000.00000000', orders: 10000 }],
  };
  const response = await api.request('/instruments/ABC/book');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ instrument: 'ABC', seq: '0', ...expected });
  const socket = io(api.url(), { transports: ['websocket'], reconnection: false });
  try {
    const book = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No snapshot')), 3000);
      socket.once('book', (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.emit('subscribe', 'ABC');
    });
    expect(await book).toEqual(expected);
  } finally {
    socket.disconnect();
  }
  await api.database().query(
    `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,priority_seq,created_at)
    VALUES ($1,'ABC','sell',100,0.00000001,0.00000001,'open',10001,now())`,
    [userId],
  );
  expect(await (await api.request('/orders/book?instrument=ABC')).json()).toMatchObject({
    asks: [{ price: '100.00', quantity: '10000000000.00000001', orders: 10001 }],
  });
});

it('rejects polling explicitly while allowing WebSocket connections', async () => {
  const polling = await api.request('/socket.io/?EIO=4&transport=polling');
  expect(polling.status).toBe(400);
  expect(await polling.json()).toEqual({ code: 0, message: 'Transport unknown' });
  const socket = io(api.url(), { transports: ['websocket'], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    expect(socket.io.engine.transport.name).toBe('websocket');
  } finally {
    socket.disconnect();
  }
});
