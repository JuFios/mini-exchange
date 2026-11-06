import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Розподілене блокування "власник інструмента" на базі Redis.
 *
 * NOTE (стартовий код): це навмисно спрощена реалізація — придатна для
 * старту проєкту, але має відомі обмеження щодо стійкості до збоїв
 * (див. ТЗ, розділ 3.2 і 4.2 — очікується коректна стратегія TTL/renewal
 * і graceful failover). Використовується лише в
 * `InstrumentOwnershipService`, який ще не підключено до `OrdersService`.
 */
@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
    });
  }

  async acquire(key: string, ownerId: string): Promise<boolean> {
    // SET key ownerId NX — блокування без TTL: якщо процес, що тримає
    // лок, аварійно завершиться, ключ лишиться в Redis назавжди.
    const result = await this.client.set(key, ownerId, 'NX');
    return result === 'OK';
  }

  async release(key: string, ownerId: string): Promise<void> {
    const current = await this.client.get(key);
    if (current === ownerId) {
      await this.client.del(key);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
