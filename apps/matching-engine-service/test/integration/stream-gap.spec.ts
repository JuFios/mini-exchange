import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import Redis from 'ioredis';
import { Socket } from 'socket.io-client';
import { ChaosHooks } from '../../src/chaos/chaos-hooks';
import { engineApp } from '../e2e/engine-app';
import { waitFor } from '../helpers/wait-for';
import { connect, disconnected, payloads, record } from '../helpers/websocket';

const api = engineApp();
const USER_EVENTS = 'exchange:user-events';
const jwt = new JwtService();
const sockets: Socket[] = [];
let peer: INestApplication | undefined;
let redis: Redis;

beforeAll(() => {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
    password: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
  });
});
afterAll(async () => {
  await redis.del(USER_EVENTS);
  redis.disconnect();
});
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  await peer?.close();
  peer = undefined;
});

/** wallet.updated так, як його пише settlement; `maxLen` задає, скільки записів лишає XADD. */
function walletEvent(userId: string, version: number, maxLen: number, withVersion = true) {
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
      version: withVersion ? String(version) : undefined,
      entryId: randomUUID(),
    },
  };
  return redis.xadd(
    USER_EVENTS,
    'MAXLEN',
    '=',
    maxLen,
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

async function replicaWithClient() {
  // Велике вікно відставання: розрив має прийти від виявлення втрати, а не від зависання.
  peer = await api.build({
    INSTANCE_ID: 'peer-stream-gap',
    ENGINE_WORKER_ENABLED: false,
    CHAOS_ENABLED: true,
    WS_REPLICA_MAX_LAG_MS: 60000,
  });
  const token = await api.register();
  const { sub } = jwt.decode(token) as { sub: string };
  const socket = await connect(await peer.getUrl(), '/private', token);
  sockets.push(socket);
  return { sub, token, socket, received: record(socket, ['wallet.updated']) };
}

const chaos = () => peer!.get(ChaosHooks);

describe('a reader that finds the entries it has not read already trimmed', () => {
  it('closes the private sockets so that clients read the state again', async () => {
    const { sub, token, socket } = await replicaWithClient();

    chaos().arm({ point: 'freeze_stream_reader' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (let version = 1; version <= 10; version++) await walletEvent(sub, version, 3);
    const closed = disconnected(socket, 8000);
    chaos().arm({ point: 'unfreeze_stream_reader' });
    await closed;

    // Після розриву клієнт підключається знову й отримує нові події.
    const again = await connect(await peer!.getUrl(), '/private', token);
    sockets.push(again);
    const received = record(again, ['wallet.updated']);
    await walletEvent(sub, 11, 3);
    await waitFor(async () => payloads(received, 'wallet.updated').length === 1, 5000);
    expect(payloads<{ version: string }>(received, 'wallet.updated')[0].version).toBe('11');
  }, 40000);

  it('closes the private sockets when unread entries vanish and nothing new arrives', async () => {
    const { sub, socket, received } = await replicaWithClient();
    await walletEvent(sub, 1, 1000);
    await waitFor(async () => payloads(received, 'wallet.updated').length === 1, 5000);

    // Непрочитані записи зникають разом зі stream (DEL чи відновлення старішої копії Redis).
    chaos().arm({ point: 'freeze_stream_reader' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await walletEvent(sub, 2, 1000);
    await walletEvent(sub, 3, 1000);
    await redis.del(USER_EVENTS);
    const closed = disconnected(socket, 8000);
    chaos().arm({ point: 'unfreeze_stream_reader' });
    await closed;
  }, 40000);

  it('closes the private sockets when an entry cannot be read and is skipped', async () => {
    const { sub, socket } = await replicaWithClient();
    const closed = disconnected(socket, 8000);
    await walletEvent(sub, 1, 1000, false);
    await closed;
  }, 40000);

  it('leaves the sockets alone when nothing was trimmed', async () => {
    const { sub, socket, received } = await replicaWithClient();

    chaos().arm({ point: 'freeze_stream_reader' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    for (let version = 1; version <= 3; version++) await walletEvent(sub, version, 1000);
    chaos().arm({ point: 'unfreeze_stream_reader' });

    await waitFor(async () => payloads(received, 'wallet.updated').length === 3, 8000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(socket.connected).toBe(true);
  }, 40000);
});
