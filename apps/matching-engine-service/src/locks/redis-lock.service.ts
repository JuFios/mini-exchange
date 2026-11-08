import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const CONNECT_WAIT_MS = 1000;
const LEASE_SCRIPT = readFileSync(join(__dirname, 'lease.lua'), 'utf8');

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  readonly client: Redis;
  private readonly ttlMs: number;

  constructor(config: ConfigService) {
    this.ttlMs = config.getOrThrow<number>('LEASE_TTL_MS');
    this.client = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: 1000,
      connectTimeout: 1000,
    });
    this.client.on('error', () => undefined);
  }

  async acquire(key: string, ownerId: string, ttlMs = this.ttlMs): Promise<boolean> {
    // Без черги offline запізнілий renew не оживить покинутий lease.
    if (this.client.status !== 'ready') {
      if (this.client.status !== 'connecting' && this.client.status !== 'connect') return false;
      // Під час LOADING ioredis лишається в `connect` без події error, тож чекання обмежене.
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = () => {
          cleanup();
          reject(new Error('Redis is unavailable'));
        };
        const timer = setTimeout(failed, CONNECT_WAIT_MS);
        const cleanup = () => {
          clearTimeout(timer);
          this.client.off('ready', ready);
          this.client.off('error', failed);
        };
        this.client.once('ready', ready);
        this.client.once('error', failed);
      });
    }
    return (await this.client.set(key, ownerId, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async renew(key: string, ownerId: string, ttlMs = this.ttlMs): Promise<number> {
    return Number(await this.client.eval(LEASE_SCRIPT, 1, key, ownerId, 'renew', ttlMs));
  }

  async release(key: string, ownerId: string): Promise<number> {
    return Number(await this.client.eval(LEASE_SCRIPT, 1, key, ownerId, 'release', this.ttlMs));
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect();
  }
}
