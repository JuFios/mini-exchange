import { ConfigService } from '@nestjs/config';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer, connect, Socket } from 'node:net';
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

const config = {
  REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
  REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
  LEASE_TTL_MS: 300,
};

it('takes over a child process lease within its TTL plus one hundred milliseconds after SIGKILL', async () => {
  const key = `lease-child:${randomUUID()}`;
  const child = fork(join(__dirname, '../helpers/lease-process.ts'), [], {
    execArgv: ['-r', 'ts-node/register/transpile-only'],
    env: { ...process.env, LOCK_KEY: key, LEASE_TTL_MS: '300' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const locks = new RedisLockService(configuration(config));
  try {
    const [message] = await once(child, 'message');
    expect(message).toEqual({ acquired: true });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const started = performance.now();
    await exited;
    await waitFor(() => locks.acquire(key, 'replacement'), 400, 50);
    expect(performance.now() - started).toBeLessThanOrEqual(400);
  } finally {
    child.kill('SIGKILL');
    await locks.client.del(key);
    await locks.onModuleDestroy();
  }
}, 10000);

it('does not renew or delete the replacement owner after an expired lease', async () => {
  const locks = new RedisLockService(configuration(config));
  const key = `lease-atomic:${randomUUID()}`;
  try {
    expect(await locks.acquire(key, 'A', 70)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(await locks.acquire(key, 'B', 1000)).toBe(true);
    const before = await locks.client.pttl(key);
    expect(await locks.renew(key, 'A')).toBe(0);
    expect(await locks.release(key, 'A')).toBe(0);
    expect(await locks.client.get(key)).toBe('B');
    expect(await locks.client.pttl(key)).toBeLessThanOrEqual(before);
    expect(await locks.renew(key, 'B', 1200)).toBe(1);
    expect(await locks.client.pttl(key)).toBeGreaterThan(1000);
  } finally {
    await locks.client.del(key);
    await locks.onModuleDestroy();
  }
});

it('fails renew immediately during a three second connection outage and never replays queued renewals', async () => {
  let online = true;
  const sockets = new Set<Socket>();
  const proxy = createServer((client) => {
    if (!online) {
      client.destroy();
      return;
    }
    const upstream = connect(config.REDIS_PORT, config.REDIS_HOST);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        sockets.delete(socket);
        client.destroy();
        upstream.destroy();
      });
    }
    client.pipe(upstream).pipe(client);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address() as { port: number };
  const locks = new RedisLockService(
    configuration({
      ...config,
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: address.port,
      LEASE_TTL_MS: 10000,
    }),
  );
  const key = `lease-outage:${randomUUID()}`;
  try {
    expect(await locks.acquire(key, 'A')).toBe(true);
    const before = await locks.client.pttl(key);
    expect(locks.client.options.port).toBe(address.port);
    expect(sockets.size).toBe(2);
    online = false;
    for (const socket of sockets) socket.destroy();
    await waitFor(async () => locks.client.status !== 'ready');
    const started = performance.now();
    await expect(locks.renew(key, 'A')).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(200);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    online = true;
    await waitFor(async () => locks.client.status === 'ready', 3000);
    const after = await locks.client.pttl(key);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before - 2800);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await locks.client.pttl(key)).toBeLessThanOrEqual(after);
    expect(await locks.renew(key, 'A', 10000)).toBe(1);
    expect(await locks.client.pttl(key)).toBeGreaterThan(after);
  } finally {
    await locks.client.del(key).catch(() => undefined);
    await locks.onModuleDestroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}, 10000);
