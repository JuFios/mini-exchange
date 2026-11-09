import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { Socket } from 'socket.io-client';
import { waitFor } from '../helpers/wait-for';
import { connect, disconnected, record, Received } from '../helpers/websocket';
import { engineApp } from './engine-app';

const api = engineApp();
const USER_EVENTS = 'exchange:user-events';
const jwt = new JwtService();
const sockets: Socket[] = [];
let redis: Redis;

beforeAll(() => {
  redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
});
afterAll(async () => {
  await redis.del(USER_EVENTS);
  redis.disconnect();
});
afterEach(() => sockets.splice(0).forEach((socket) => socket.disconnect()));

async function account() {
  const email = `${randomUUID()}@example.test`;
  const response = await api.request('/auth/register', 'POST', undefined, {
    email,
    password: 'example-password',
  });
  const tokens = (await response.json()) as { accessToken: string; refreshToken: string };
  const claims = jwt.decode(tokens.accessToken) as { sub: string; exp: number };
  return { ...tokens, email, userId: claims.sub, exp: claims.exp };
}

async function listen(token: string): Promise<Received[]> {
  const socket = await connect(api.url(), '/private', token);
  sockets.push(socket);
  return record(socket, ['order.updated', 'wallet.updated']);
}

/** Подія wallet.updated у тому вигляді, в якому її пише settlement. */
function walletEvent(userId: string, version: string) {
  const eventId = randomUUID();
  const envelope = {
    eventId,
    type: 'wallet.updated',
    version: 1,
    occurredAt: new Date().toISOString(),
    producer: 'settlement',
    payload: {
      userId,
      asset: 'USD',
      available: '90',
      reserved: '10',
      version,
      entryId: randomUUID(),
    },
  };
  return redis.xadd(
    USER_EVENTS,
    '*',
    'eventId',
    eventId,
    'type',
    'wallet.updated',
    'version',
    '1',
    'instrument',
    '',
    'seq',
    '',
    'traceparent',
    '',
    'envelope',
    JSON.stringify(envelope),
  );
}

it('refuses a handshake without a valid access token', async () => {
  const user = await account();
  const expired = jwt.sign(
    {
      sub: user.userId,
      email: 'a@example.test',
      typ: 'access',
      exp: Math.floor(Date.now() / 1000) - 5,
    },
    { secret: process.env.JWT_ACCESS_SECRET },
  );
  const forged = jwt.sign(
    { sub: user.userId, email: 'a@example.test', typ: 'access' },
    { secret: 'x'.repeat(40) },
  );
  for (const token of [undefined, '', 'garbage', user.refreshToken, expired, forged])
    await expect(connect(api.url(), '/private', token)).rejects.toThrow('UNAUTHORIZED');
  await expect(connect(api.url(), '/private', user.accessToken)).resolves.toBeDefined();
});

it('delivers order and wallet updates only to their owner and without identities', async () => {
  const [a, b] = await Promise.all([account(), account()]);
  const [forA, forB] = [await listen(a.accessToken), await listen(b.accessToken)];

  const placed = await (await api.submit(a.accessToken, { price: 100 })).json();
  await waitFor(async () => forA.some(({ event }) => event === 'order.updated'), 5000);
  await walletEvent(a.userId, '5');
  await waitFor(async () => forA.some(({ event }) => event === 'wallet.updated'), 5000);

  expect(forA.find(({ event }) => event === 'order.updated')?.payload).toEqual({
    orderId: placed.order.id,
    instrument: 'ABC',
    version: 1,
    status: 'open',
    remainingQuantity: '1.00000000',
    filledQuantity: '0.00000000',
  });
  expect(forA.find(({ event }) => event === 'wallet.updated')?.payload).toEqual({
    asset: 'USD',
    available: '90',
    reserved: '10',
    version: '5',
  });
  expect(JSON.stringify(forA)).not.toMatch(/userId|ownerId|entryId/);
  // Події B дійшли б за той самий час, що й події A.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(forB).toEqual([]);
});

it('drops a repeated stream entry and keeps delivering the next ones', async () => {
  const user = await account();
  const received = await listen(user.accessToken);
  const id = await walletEvent(user.userId, '1');
  const [entry] = await redis.xrange(USER_EVENTS, id!, id!);
  await redis.xadd(USER_EVENTS, '*', ...entry[1]);
  await walletEvent(user.userId, '2');
  await waitFor(async () => received.length === 2, 5000);
  expect(received.map(({ payload }) => (payload as { version: string }).version)).toEqual([
    '1',
    '2',
  ]);
});

describe('with a short access token', () => {
  it('disconnects the socket at expiry and accepts a fresh token', async () => {
    await api.restart({ JWT_ACCESS_TTL: 2 });
    const user = await account();
    const socket = await connect(api.url(), '/private', user.accessToken);
    sockets.push(socket);

    const at = await disconnected(socket, 6000);
    expect(at).toBeGreaterThanOrEqual(user.exp * 1000 - 50);
    expect(at - user.exp * 1000).toBeLessThan(1000);

    const login = await api.request('/auth/login', 'POST', undefined, {
      email: user.email,
      password: 'example-password',
    });
    const fresh = ((await login.json()) as { accessToken: string }).accessToken;
    const received = await listen(fresh);
    expect((await api.submit(fresh)).status).toBe(201);
    await waitFor(async () => received.some(({ event }) => event === 'order.updated'), 5000);
  }, 20000);
});
