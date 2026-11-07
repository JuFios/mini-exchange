import { ConfigService } from '@nestjs/config';
import { RedisLockService } from '../../src/locks/redis-lock.service';

const locks = new RedisLockService(
  new ConfigService({
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
    LEASE_TTL_MS: Number(process.env.LEASE_TTL_MS),
  }),
);
void locks
  .acquire(process.env.LOCK_KEY!, 'child')
  .then((acquired) => {
    process.send?.({ acquired });
    setInterval(() => undefined, 1000);
  })
  .catch(() => process.exit(1));
