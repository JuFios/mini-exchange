import { randomUUID } from 'node:crypto';
import { connect, disconnected, emitWithAck } from '../helpers/websocket';
import { engineApp } from './engine-app';

const api = engineApp();
const from = (address: string) => ({ 'x-forwarded-for': address });

it('shares a 10-order window between both replicas and leaves a second user unaffected', async () => {
  const options = { ORDER_RATE_LIMIT: 10, ORDER_RATE_TTL_MS: 60_000 };
  await api.restart(options);
  const replica = await api.build({ ...options, INSTANCE_ID: 'peer' });
  try {
    const [first, second] = await Promise.all([api.register(), api.register()]);
    const urls = [api.url(), await replica.getUrl()];
    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        fetch(urls[index % 2] + '/orders', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + first, 'content-type': 'application/json' },
          body: JSON.stringify({ instrument: 'ABC', side: 'sell', price: '100', quantity: '1' }),
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    );
    expect(responses.filter(({ ok }) => ok)).toHaveLength(10);
    const denied = responses.filter(({ status }) => status === 429);
    expect(denied).toHaveLength(20);
    for (const response of denied)
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await api.submit(second)).ok).toBe(true);
  } finally {
    await replica.close();
  }
}, 30_000);

it('limits authentication independently by client IP and normalized login email', async () => {
  await api.restart({ AUTH_RATE_LIMIT: 10, LOGIN_EMAIL_RATE_LIMIT: 10 });
  const login = (ip: string, email: string) =>
    api.request(
      '/auth/login',
      'POST',
      undefined,
      { email, password: 'incorrect-password' },
      from(ip),
    );
  const send = async (sendOne: (i: number) => Promise<Response>) => {
    for (let index = 0; index < 11; index++) {
      const response = await sendOne(index);
      if (index < 10) expect(response.status).toBe(401);
      else {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      }
    }
  };
  await send(() => login('198.51.100.10', `${randomUUID()}@example.test`));
  expect((await login('198.51.100.11', `${randomUUID()}@example.test`)).status).toBe(401);

  const target = `${randomUUID()}@example.test`;
  await send((index) =>
    login(`192.0.2.${index + 1}`, index % 2 === 0 ? target : target.toUpperCase()),
  );
});

it('rejects the 121st public read from the same IP and accepts another IP', async () => {
  await api.restart({ PUBLIC_RATE_LIMIT: 120 });
  const read = (ip: string) =>
    api.request('/instruments/ABC/book', 'GET', undefined, undefined, from(ip));
  for (let index = 0; index < 121; index++) {
    expect((await read('198.51.100.20')).status).toBe(index < 120 ? 200 : 429);
  }
  expect((await read('198.51.100.21')).status).toBe(200);
});

it('rejects the 21st market subscription and disconnects on a frame over 16 KiB', async () => {
  await api.restart({ WS_SUBSCRIBE_RATE_LIMIT: 20 });
  const socket = await connect(api.url(), '/market');
  try {
    for (let index = 0; index < 20; index++) {
      expect(await emitWithAck(socket, 'book.subscribe', { instrument: 'ABC' })).toMatchObject({
        ok: true,
      });
    }
    expect(await emitWithAck(socket, 'book.subscribe', { instrument: 'ABC' })).toEqual({
      ok: false,
      error: 'RATE_LIMITED',
    });
    const closed = disconnected(socket, 3000);
    socket.emit('book.subscribe', { instrument: 'ABC', padding: 'a'.repeat(16_385) });
    await closed;
  } finally {
    socket.disconnect();
  }
});
