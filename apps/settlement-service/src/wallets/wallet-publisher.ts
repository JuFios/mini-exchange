import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Envelope, WalletUpdatedV1 } from '../contracts/events';

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

  async publishBestEffort(payload: WalletUpdatedV1): Promise<void> {
    const envelope: Envelope<WalletUpdatedV1> = {
      eventId: randomUUID(),
      type: 'wallet.updated',
      version: 1,
      occurredAt: new Date().toISOString(),
      producer: 'settlement',
      payload,
    };
    try {
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
    } catch {
      this.logger.warn({ alert: 'wallet_update_publish_failed', entryId: payload.entryId });
    }
  }
}
