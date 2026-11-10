import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { outboxStreamFields, OutboxStreamRow } from './streams';

const RELAY_LOCK = 0x6f757462;
const REDIS_TIMEOUT_MS = 1000;
const RELAY_IDLE_TIMEOUT_MS = 5000;
const PUBLISH_SCRIPT = readFileSync(join(__dirname, 'publish.lua'), 'utf8');

interface OutboxRow extends OutboxStreamRow {
  id: string;
  stream: string;
}

@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly redis: Redis;
  private readonly pollMs: number;
  private readonly maxLen: number;
  private readonly positionsKey: string;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly source: DataSource,
    config: ConfigService,
  ) {
    this.pollMs = config.getOrThrow<number>('OUTBOX_POLL_INTERVAL_MS');
    this.maxLen = config.getOrThrow<number>('STREAM_MAXLEN');
    this.positionsKey = `exchange:outbox:positions:${config.getOrThrow<string>('DATABASE_NAME')}`;
    this.redis = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      password: config.getOrThrow<string>('REDIS_PASSWORD'),
      commandTimeout: REDIS_TIMEOUT_MS,
      socketTimeout: REDIS_TIMEOUT_MS,
      connectTimeout: REDIS_TIMEOUT_MS,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
    });
    this.redis.on('error', () => undefined);
  }

  onApplicationBootstrap(): void {
    this.schedule(this.pollMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    try {
      await this.running;
    } finally {
      this.redis.disconnect();
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.drain()
        .catch((error: unknown) => {
          this.logger.error({
            alert: 'outbox_publish_failed',
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => this.schedule(this.pollMs));
    }, delay).unref();
  }

  private async drain(): Promise<void> {
    while (!this.stopped && (await this.publishNext())) {
      // Під backlog кожен COMMIT звільняє lock і дає іншим реплікам можливість публікувати.
    }
  }

  private async publishNext(): Promise<boolean> {
    if (this.redis.status !== 'ready') return false;
    return this.source.transaction(async (db) => {
      const [{ locked }]: { locked: boolean }[] = await db.query(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [RELAY_LOCK],
      );
      if (!locked) return false;

      // Один рядок на COMMIT: повтор не повертає stream до попереднього seq.
      const [row]: OutboxRow[] = await db.query(
        `SELECT id, event_id, stream, type, version, instrument, seq, payload, traceparent, created_at
         FROM outbox WHERE published_at IS NULL
         ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!row) return false;

      await db.query(`SET LOCAL idle_in_transaction_session_timeout = ${RELAY_IDLE_TIMEOUT_MS}`);
      // Скрипт відхиляє запізнілий XADD, якщо lock уже перейшов до relay, який просунув stream.
      // Один виклик Redis обмежено 1 с, локальний ліміт PG залишає запас.
      // eslint-disable-next-line no-restricted-syntax
      const streamId = await this.redis.eval(
        PUBLISH_SCRIPT,
        2,
        this.positionsKey,
        row.stream,
        JSON.stringify([row.stream, row.instrument]),
        row.id,
        this.maxLen,
        ...outboxStreamFields(row),
      );
      if (typeof streamId !== 'string') throw new Error('Redis rejected a stale outbox append');

      const [, marked] = await db.query(
        'UPDATE outbox SET published_at = clock_timestamp() WHERE id = $1 AND published_at IS NULL',
        [row.id],
      );
      if (marked !== 1) throw new Error('Outbox row changed during publication');
      return true;
    });
  }
}
