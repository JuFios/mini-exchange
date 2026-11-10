import { setTimeout as delay } from 'node:timers/promises';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ChaosHooks } from '../chaos/chaos-hooks';
import { marketStream, USER_EVENTS_STREAM } from '../outbox/streams';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { MarketEvent, parseEnvelope, seqOf, UserEvent } from './realtime-events';
import { checkBatch, RecentIds, StreamCounters, streamPosition } from './replica-lag';

const BLOCK_MS = 1000;
const REDIS_TIMEOUT_MS = 3000;
const PROBE_TIMEOUT_MS = 1000;
const BATCH = 100;
const MAX_BACKOFF_MS = 2000;
const RECENT_EVENT_IDS = 4096;
const ERROR_LOG_INTERVAL_MS = 5000;
const FROZEN_POLL_MS = 50;

type Handler<T> = (event: T) => void;

/** Лічильники stream і його хвіст, прочитані однією відповіддю `XINFO STREAM`. */
interface StreamState extends StreamCounters {
  lastId: string;
}

/**
 * Читає market-stream усіх інструментів і stream подій користувачів однією блокуючою командою
 * XREAD зі збереженим `lastId`. Читає лише закомічене й опубліковане relay: стану власника
 * інструмента в пам'яті цей шлях не бачить.
 */
@Injectable()
export class RealtimeStreamReader implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeStreamReader.name);
  private readonly redis: Redis;
  // Блокуюча команда займає з'єднання, тож короткі читання хвоста йдуть окремим клієнтом.
  private readonly probe: Redis;
  private readonly market = new Set<Handler<MarketEvent>>();
  private readonly user = new Set<Handler<UserEvent>>();
  private readonly gaps = new Set<Handler<string>>();
  // Скільки записів stream прочитано і підтверджено лічильниками, курсор на той момент і скільки
  // прочитано відтоді. Збій `XINFO` лише відкладає перевірку: пачки не губляться.
  private readonly verified = new Map<string, bigint>();
  private readonly verifiedAt = new Map<string, bigint>();
  private readonly unverified = new Map<string, number>();
  private readonly emitted = new Map<string, bigint>();
  private readonly seen = new RecentIds(RECENT_EVENT_IDS);
  private keys: string[] = [];
  private readonly instruments: InstrumentCatalog;
  private ids?: Map<string, string>;
  private loop?: Promise<void>;
  private stopped = false;
  private readonly abort = new AbortController();
  private lastErrorLogAt = 0;

  constructor(
    config: ConfigService,
    instruments: InstrumentCatalog,
    private readonly chaos: ChaosHooks,
  ) {
    this.instruments = instruments;
    const connection = {
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      connectTimeout: REDIS_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    };
    // Тайм-аут команди більший за BLOCK, інакше порожнє очікування рахувалося б відмовою.
    this.redis = new Redis({ ...connection, commandTimeout: REDIS_TIMEOUT_MS });
    this.probe = new Redis({ ...connection, commandTimeout: PROBE_TIMEOUT_MS });
    this.redis.on('error', () => undefined);
    this.probe.on('error', () => undefined);
  }

  onApplicationBootstrap(): void {
    // Каталог інструментів заповнюється в onModuleInit, тож у конструкторі він ще порожній.
    this.keys = [
      ...this.instruments.list().map(({ symbol }) => marketStream(symbol)),
      USER_EVENTS_STREAM,
    ];
    this.loop = this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.redis.disconnect();
    this.probe.disconnect();
    await this.loop;
  }

  /** Поки хвости stream не визначено, репліка не знає, з якого запису читати. */
  get ready(): boolean {
    return this.ids !== undefined;
  }

  onMarket(handler: Handler<MarketEvent>): () => void {
    this.market.add(handler);
    return () => this.market.delete(handler);
  }

  onUser(handler: Handler<UserEvent>): () => void {
    this.user.add(handler);
    return () => this.user.delete(handler);
  }

  /**
   * Викликається, коли репліка виявила, що записи stream обрізано до того, як вона їх прочитала.
   * Читач вже стоїть на хвості stream; решта залежить від того, чи клієнт сам помічає пропуск.
   */
  onGap(handler: Handler<string>): () => void {
    this.gaps.add(handler);
    return () => this.gaps.delete(handler);
  }

  /** Найбільший `seq` book.delta, який репліка вже роздала (або мав хвіст stream на старті). */
  emittedSeq(instrument: string): bigint {
    return this.emitted.get(instrument) ?? 0n;
  }

  /** Stream, які читає репліка: market усіх інструментів і події користувачів. */
  get streams(): readonly string[] {
    return this.keys;
  }

  /** Позиція, до якої репліка вже прочитала stream (на старті це його хвіст). */
  cursor(stream: string): bigint {
    return streamPosition(this.ids?.get(stream) ?? '0-0');
  }

  /** Позиція останнього запису stream: що relay уже опублікував. */
  async head(stream: string): Promise<bigint> {
    const [tail] = await this.probe.xrevrange(stream, '+', '-', 'COUNT', 1);
    return streamPosition(tail?.[0] ?? '0-0');
  }

  private async run(): Promise<void> {
    let backoff = 250;
    while (!this.stopped) {
      try {
        this.ids ??= await this.tails();
        if (this.chaos.readerFrozen) {
          await this.pause(FROZEN_POLL_MS);
          continue;
        }
        const reply = await this.redis.xread(
          'COUNT',
          BATCH,
          'BLOCK',
          BLOCK_MS,
          'STREAMS',
          ...this.keys,
          ...this.keys.map((key) => this.ids!.get(key)!),
        );
        backoff = 250;
        // Заморозка, що настала під час очікування, не віддає прочитане: ID не просуваються,
        // тож після розморозки записи прочитаються знову.
        if (this.chaos.readerFrozen) continue;
        for (const [key, entries] of reply ?? []) {
          for (const [id, fields] of entries) {
            this.consume(fields);
            this.ids.set(key, id);
          }
          this.unverified.set(key, (this.unverified.get(key) ?? 0) + entries.length);
        }
        for (const [key, entries] of reply ?? []) if (entries.length > 0) await this.verify(key);
      } catch (error) {
        if (this.stopped) return;
        this.logFailure(error);
        await this.pause(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Читання з `$` у циклі пропустило б записи між двома викликами, тому береться справжній
   * ID хвоста. Клієнти, що підписалися після старту, беруть snapshot з PG і не потребують
   * записів, опублікованих раніше.
   */
  private async tails(): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const key of this.keys) {
      // Лічильники беруться до хвоста: запис, доданий між двома викликами, не завищить прочитане.
      const state = await this.streamState(key);
      const [tail] = await this.probe.xrevrange(key, '+', '-', 'COUNT', 1);
      ids.set(key, tail?.[0] ?? '0-0');
      if (state) {
        this.verified.set(key, state.added);
        this.verifiedAt.set(key, streamPosition(tail?.[0] ?? '0-0'));
        this.unverified.set(key, 0);
      }
      const instrument = /^exchange:market:\{(.+)\}$/.exec(key)?.[1];
      // Хвіст може бути пошкодженим записом: без числового `seq` лічильник лишається нульовим.
      const seq = tail ? seqOf(tail[1]) : undefined;
      if (instrument && seq !== undefined) this.emitted.set(instrument, seq);
    }
    return ids;
  }

  /**
   * Лічильники й хвіст stream однією відповіддю. `undefined`, якщо Redis їх не віддає (до 7.0):
   * тоді втрату виявити неможливо, і читач працює як раніше. Відсутній ключ — порожній stream.
   */
  private async streamState(stream: string): Promise<StreamState | undefined> {
    let reply: unknown[];
    try {
      reply = (await this.probe.xinfo('STREAM', stream)) as unknown[];
    } catch (error) {
      if (/no such key/i.test(error instanceof Error ? error.message : '')) {
        return { added: 0n, length: 0n, firstId: 0n, lastId: '0-0' };
      }
      throw error;
    }
    const fields = new Map<string, unknown>();
    for (let i = 0; i + 1 < reply.length; i += 2) fields.set(String(reply[i]), reply[i + 1]);
    const added = fields.get('entries-added');
    const length = fields.get('length');
    const first = fields.get('recorded-first-entry-id');
    const last = fields.get('last-generated-id');
    if (
      typeof added !== 'number' ||
      typeof length !== 'number' ||
      typeof first !== 'string' ||
      typeof last !== 'string'
    )
      return undefined;
    return {
      added: BigInt(added),
      length: BigInt(length),
      firstId: streamPosition(first),
      lastId: last,
    };
  }

  /**
   * Звіряє прочитане з лічильниками stream. Якщо між курсором і найстаршим наявним записом
   * були записи, яких уже немає, читач ставить курсор на хвіст і повідомляє про розрив:
   * доставляти хвіст після прогалини без того, хто її помітить, не можна. Збій перевірки
   * не зупиняє читання: прочитане лишається неперевіреним до наступного успіху.
   */
  private async verify(key: string): Promise<void> {
    const verified = this.verified.get(key);
    const verifiedAt = this.verifiedAt.get(key);
    if (verified === undefined || verifiedAt === undefined) return;
    try {
      const state = await this.streamState(key);
      if (!state) return;
      const result = checkBatch(verified, verifiedAt, this.unverified.get(key) ?? 0, state);
      this.verified.set(key, result.verified);
      this.unverified.set(key, 0);
      if (!result.lost) {
        this.verifiedAt.set(key, this.cursor(key));
        return;
      }
      this.ids!.set(key, state.lastId);
      this.verifiedAt.set(key, streamPosition(state.lastId));
      this.logger.error({
        alert: 'realtime_stream_gap',
        message: `Entries of ${key} were trimmed or lost before this replica read them`,
      });
      for (const handler of this.gaps) {
        try {
          handler(key);
        } catch (error) {
          this.logFailure(error);
        }
      }
    } catch (error) {
      if (!this.stopped) this.logFailure(error);
    }
  }

  /** Запис, який не вдалося обробити, пропускається: курсор усе одно просувається за ним. */
  private consume(fields: string[]): void {
    try {
      this.dispatch(fields);
    } catch (error) {
      this.logger.warn({
        alert: 'realtime_event_skipped',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private dispatch(fields: string[]): void {
    const event = parseEnvelope(fields);
    // Пошкоджений запис не зупиняє читача й не повторюється.
    if (!event) {
      this.logger.warn({ alert: 'realtime_event_skipped', message: 'Unreadable stream entry' });
      return;
    }
    // Relay може повторити останній запис після збою між XADD і позначкою публікації.
    if (!this.seen.add(event.eventId)) return;
    if (event.type === 'book.delta') {
      const seq = BigInt(event.payload.seq);
      if (seq > this.emittedSeq(event.payload.instrument))
        this.emitted.set(event.payload.instrument, seq);
    }
    const handlers: Set<Handler<never>> =
      event.type === 'book.delta' || event.type === 'trade.public' ? this.market : this.user;
    for (const handler of handlers) {
      try {
        (handler as Handler<typeof event>)(event);
      } catch (error) {
        this.logFailure(error);
      }
    }
  }

  /** Пауза переривається зупинкою застосунку, тож shutdown не чекає завершення backoff. */
  private pause(ms: number): Promise<void> {
    return delay(ms, undefined, { signal: this.abort.signal }).catch(() => undefined);
  }

  private logFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLogAt = now;
    this.logger.error({
      alert: 'realtime_stream_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
