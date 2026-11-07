import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisLockService } from '../../src/locks/redis-lock.service';

it('expires a crashed owner lock and lets another owner acquire it', async () => {
  const values = {
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
    LEASE_TTL_MS: 120,
  };
  const lock = new RedisLockService(new ConfigService(values));
  const redis = new Redis({ host: values.REDIS_HOST, port: values.REDIS_PORT });
  const key = `lock-regression:${randomUUID()}`;
  try {
    expect(await lock.acquire(key, 'crashed-owner')).toBe(true);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(await lock.acquire(key, 'replacement-owner')).toBe(true);
  } finally {
    await redis.del(key);
    redis.disconnect();
    await lock.onModuleDestroy();
  }
});
