import { ConfigService } from '@nestjs/config';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer, Socket } from 'node:net';
import { RedisLockService } from '../../src/locks/redis-lock.service';
import { waitFor } from '../helpers/wait-for';

function configuration(values: Record<string, string | number>): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing test configuration ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

it('stops waiting for a Redis that stays in LOADING', async () => {
  // INFO із loading:1 тримає ioredis у стані connect без події error.
  const body = 'loading:1\r\nloading_eta_seconds:60\r\n';
  const sockets = new Set<Socket>();
  const loading = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => socket.write(`$${body.length}\r\n${body}\r\n`));
  });
  loading.listen(0, '127.0.0.1');
  await once(loading, 'listening');
  const port = (loading.address() as { port: number }).port;
  const locks = new RedisLockService(
    configuration({ REDIS_HOST: '127.0.0.1', REDIS_PORT: port, LEASE_TTL_MS: 300 }),
  );
  try {
    await waitFor(async () => locks.client.status === 'connect', 3000);
    const started = performance.now();
    await expect(locks.acquire(`lease-loading:${randomUUID()}`, 'A')).rejects.toThrow(
      'Redis is unavailable',
    );
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    await locks.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => loading.close(() => resolve()));
  }
}, 10000);
