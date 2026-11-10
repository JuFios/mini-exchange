import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Envelope, WalletUpdatedV1 } from '../contracts/events';

const CONNECT_WAIT_MS = 1000;

@Injectable()
export class WalletPublisher implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly maxLength: number;
  private readonly logger = new Logger(WalletPublisher.name);

  constructor(config: ConfigService) {
    this.maxLength = config.getOrThrow<number>('STREAM_MAXLEN');
    this.redis = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      password: config.getOrThrow<string>('REDIS_PASSWORD'),
      commandTimeout: 1000,
      connectTimeout: 1000,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  /** Кидає помилку, щоб consumer не підтвердив запис, поки сповіщення не опубліковано. */
  async publish(payload: WalletUpdatedV1): Promise<void> {
    await this.connected();
    await this.append(payload);
  }

  private async append(payload: WalletUpdatedV1): Promise<void> {
    const envelope: Envelope<WalletUpdatedV1> = {
      eventId: randomUUID(),
      type: 'wallet.updated',
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'settlement',
      payload,
    };
    await this.redis.xadd(
      'exchange:user-events',
      'MAXLEN',
      '~',
      this.maxLength,
      '*',
      'eventId',
      envelope.eventId,
      'type',
      envelope.type,
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

  // Без черги команд XADD одразу після старту падав би, і запис чекав би на reclaim 30 с.
  private async connected(): Promise<void> {
    if (this.redis.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, CONNECT_WAIT_MS);
      this.redis.once('ready', done);
    });
  }

  async publishBestEffort(payload: WalletUpdatedV1): Promise<void> {
    // HTTP-шлях резерву має дедлайн 2 с в engine, тож тут без очікування готовності.
    try {
      await this.append(payload);
    } catch {
      this.logger.warn({ alert: 'wallet_update_publish_failed', entryId: payload.entryId });
    }
  }
}
