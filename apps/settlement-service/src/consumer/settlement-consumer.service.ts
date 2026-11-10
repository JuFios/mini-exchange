import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { classifyFailure } from './failure-kind';
import { SettlementEventHandler } from './settlement-event.handler';
import { SettlementStats } from './settlement-stats';
import { DEAD_LETTER_STREAM, GROUP, SETTLEMENT_STREAMS } from './streams';

const BATCH_SIZE = 50;
const BLOCK_MS = 1000;
const RETRY_MS = 250;
const REDIS_COMMAND_TIMEOUT_MS = 3000;
const DEAD_LETTER_SCRIPT = readFileSync(join(__dirname, 'dead-letter.lua'), 'utf8');

type Entry = [string, string[]];

@Injectable()
export class SettlementConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SettlementConsumer.name);
  private readonly redis: Redis;
  private readonly reader: Redis;
  private readonly name: string;
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly maxLength: number;
  private readonly cursors = new Map(SETTLEMENT_STREAMS.map((stream) => [stream, '0-0']));
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    config: ConfigService,
    private readonly handler: SettlementEventHandler,
    private readonly source: DataSource,
    private readonly stats: SettlementStats,
  ) {
    this.name = config.getOrThrow('CONSUMER_NAME');
    this.claimIdleMs = config.getOrThrow('CONSUMER_CLAIM_IDLE_MS');
    this.maxDeliveries = config.getOrThrow('CONSUMER_MAX_DELIVERIES');
    this.maxLength = config.getOrThrow('STREAM_MAXLEN');
    this.redis = new Redis({
      host: config.getOrThrow('REDIS_HOST'),
      port: config.getOrThrow('REDIS_PORT'),
      maxRetriesPerRequest: 1,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    });
    this.reader = this.redis.duplicate();
    for (const client of [this.redis, this.reader])
      client.on('error', (error) => this.logger.warn(error.message));
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.reader.disconnect();
    await this.running;
    this.redis.disconnect();
  }

  /** Redis готовий лише з політикою, що зберігає pending-записи. */
  async redisReady(): Promise<boolean> {
    const [ping, policy] = await Promise.all([
      this.redis.ping(),
      this.redis.config('GET', 'maxmemory-policy'),
    ]);
    return ping === 'PONG' && Array.isArray(policy) && policy[1] === 'noeviction';
  }

  /** Стан черги для адміністратора й метрик. */
  async queue() {
    const streams = await Promise.all(
      SETTLEMENT_STREAMS.map(async (stream) => {
        const [length, groups] = await Promise.all([
          this.redis.xlen(stream),
          (this.redis.xinfo('GROUPS', stream) as Promise<unknown[][]>).catch(
            () => [] as unknown[][],
          ),
        ]);
        // XINFO повертає пари ключ-значення; lag є в Redis 7.0+.
        const info =
          groups.map((fields) => Object.fromEntries(pairs(fields))).find((g) => g.name === GROUP) ??
          {};
        return {
          stream,
          length,
          pending: Number(info.pending ?? 0),
          lag: info.lag === null || info.lag === undefined ? null : Number(info.lag),
          lastDeliveredId: (info['last-delivered-id'] as string | undefined) ?? null,
        };
      }),
    );
    const [deadLetters, [failures]] = await Promise.all([
      this.redis.xlen(DEAD_LETTER_STREAM),
      this.source.query('SELECT count(*)::int AS count FROM settlement_failures'),
    ]);
    return { group: GROUP, consumer: this.name, streams, deadLetters, failures: failures.count };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.ensureGroups();
        while (!this.stopped) {
          for (const stream of SETTLEMENT_STREAMS) await this.reclaim(stream);
          const read = (await this.reader.xreadgroup(
            'GROUP',
            GROUP,
            this.name,
            'COUNT',
            BATCH_SIZE,
            'BLOCK',
            BLOCK_MS,
            'STREAMS',
            ...SETTLEMENT_STREAMS,
            ...SETTLEMENT_STREAMS.map(() => '>'),
          )) as [string, Entry[]][] | null;
          for (const [stream, entries] of read ?? [])
            for (const entry of entries) {
              if (this.stopped) return;
              await this.process(stream, entry);
            }
        }
      } catch (error) {
        if (this.stopped) return;
        this.logger.warn(`Consumer retry: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  // Група створюється з 0, тож consumer бачить усю історію stream. Після DEL stream
  // (перед redrive) цикл потрапляє сюди знову через NOGROUP.
  private async ensureGroups(): Promise<void> {
    for (const stream of SETTLEMENT_STREAMS) {
      try {
        await this.redis.xgroup('CREATE', stream, GROUP, '0', 'MKSTREAM');
      } catch (error) {
        if (!(error as Error).message.includes('BUSYGROUP')) throw error;
      }
    }
  }

  private async reclaim(stream: string): Promise<void> {
    const [cursor, entries, deleted] = (await this.redis.xautoclaim(
      stream,
      GROUP,
      this.name,
      this.claimIdleMs,
      this.cursors.get(stream)!,
      'COUNT',
      BATCH_SIZE,
    )) as [string, Entry[], string[]?];
    this.cursors.set(stream, cursor);
    // Redis 7 сам прибирає з PEL записи, обрізані XTRIM; їхній payload втрачено, звірка покаже пропуск.
    if (deleted?.length) {
      this.stats.trimmedPending += deleted.length;
      this.logger.error({ alert: 'settlement_trimmed_pending', stream, count: deleted.length });
    }
    for (const entry of entries) {
      if (this.stopped) return;
      await this.process(stream, entry);
    }
  }

  private async process(stream: string, [id, fields]: Entry): Promise<void> {
    try {
      const values = toRecord(fields);
      await this.handler.handle(id, values.envelope);
      await this.redis.xack(stream, GROUP, id);
    } catch (error) {
      await this.fail(stream, id, fields, error).catch((failure: Error) =>
        // Запис лишається в PEL і повернеться через reclaim.
        this.logger.error({
          alert: 'settlement_failure_handling_failed',
          stream,
          id,
          message: failure.message,
        }),
      );
    }
  }

  private async fail(stream: string, id: string, fields: string[], error: unknown): Promise<void> {
    const kind = classifyFailure(error);
    const reason = (error as Error).message?.slice(0, 500) ?? 'Unknown error';
    if (kind === 'transient') {
      // Збій середовища не вважається дефектом запису: DLQ тут неприпустимий за будь-якої кількості доставок.
      this.stats.transientFailures++;
      this.logger.error({ alert: 'settlement_transient_failure', stream, id, reason });
      return;
    }
    if (kind === 'other') {
      const deliveries = await this.deliveries(stream, id);
      if (deliveries < this.maxDeliveries) {
        this.stats.retriedFailures++;
        this.logger.warn({ stream, id, deliveries, reason });
        return;
      }
    }
    await this.deadLetter(stream, id, fields, reason);
  }

  private async deliveries(stream: string, id: string): Promise<number> {
    const pending = (await this.redis.xpending(stream, GROUP, id, id, 1)) as [
      string,
      string,
      number,
      number,
    ][];
    return pending[0] ? Number(pending[0][3]) : 0;
  }

  private async deadLetter(
    stream: string,
    id: string,
    fields: string[],
    reason: string,
  ): Promise<void> {
    const values = toRecord(fields);
    // Рядок журналу ідемпотентний, тож повтор після збою Redis не дублює його.
    const insert = (payload: object) =>
      this.source.query(
        `INSERT INTO settlement_failures (stream, message_id, trade_id, reason, payload)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (stream, message_id) DO NOTHING`,
        [stream, id, tradeIdOf(values.envelope), reason, JSON.stringify(payload)],
      );
    try {
      await insert({ fields: values });
    } catch (error) {
      // jsonb не приймає \u0000 і самотні сурогати (клас 22); запис без цього не лишився б у PEL назавжди.
      if (!/^22/.test((error as { driverError?: { code?: string } }).driverError?.code ?? ''))
        throw error;
      await insert({
        encoding: 'base64',
        fields: Buffer.from(JSON.stringify(fields)).toString('base64'),
      });
    }
    // eslint-disable-next-line no-restricted-syntax
    const moved = await this.redis.eval(
      DEAD_LETTER_SCRIPT,
      2,
      stream,
      DEAD_LETTER_STREAM,
      GROUP,
      id,
      reason,
      JSON.stringify(fields),
      this.maxLength,
    );
    // 0 означає, що запис уже підтверджено іншим consumer: DLQ не дублюється й не рахується.
    if (moved === 1) {
      this.stats.deadLettered++;
      this.logger.error({ alert: 'settlement_dead_letter', stream, id, reason });
    }
  }
}

function toRecord(fields: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) values[fields[i]] = fields[i + 1];
  return values;
}

function pairs(fields: unknown[]): [string, unknown][] {
  const result: [string, unknown][] = [];
  for (let i = 0; i < fields.length; i += 2) result.push([fields[i] as string, fields[i + 1]]);
  return result;
}

function tradeIdOf(envelope: string | undefined): string | null {
  try {
    const id = JSON.parse(envelope ?? '')?.payload?.tradeId;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}
