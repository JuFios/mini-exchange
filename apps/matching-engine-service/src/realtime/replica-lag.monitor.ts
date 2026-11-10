import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { LagTracker } from './replica-lag';

export const HEARTBEAT_INTERVAL_MS = 2000;
// Після `stale` репліка повертається в пул, лише коли вердикт чистий три тіки поспіль: інакше
// репліка на межі вікна мигала б, і nginx то виводив би її з ротації, то повертав.
const RECOVER_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * Раз на HEARTBEAT_INTERVAL_MS робить дві незалежні справи. Heartbeat: читає `last_applied_seq`
 * з PG і роздає його, щоб клієнт порівняв із отриманим і завислий XREAD-цикл не лишав його `live`
 * на застарілій книзі. Проба: перевіряє, чи просувається репліка за кожним stream, який
 * опублікував relay. Збій або зависання PG не зупиняє пробу, а збій Redis не зупиняє heartbeat.
 */
@Injectable()
export class ReplicaLagMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaLagMonitor.name);
  private readonly trackers = new Map<string, LagTracker>();
  private readonly heartbeats = new Set<(instrument: string, seq: string) => void>();
  private readonly staleHandlers = new Set<() => void>();
  private readonly lags = new Map<string, bigint>();
  private readonly maxLagMs: number;
  // Одна пропущена проба (тік 2 с плюс проба до 1 с) не повинна знімати репліку з ротації.
  private readonly validForMs: number;
  private timer?: NodeJS.Timeout;
  private beating = false;
  private probing = false;
  // Репліка оголошена завислою й ще не відновилася. `cleanSince` — з якого моменту вердикт чистий.
  private latched = false;
  private cleanSince?: number;

  constructor(
    config: ConfigService,
    private readonly source: DataSource,
    private readonly reader: RealtimeStreamReader,
    private readonly instruments: InstrumentCatalog,
  ) {
    this.maxLagMs = config.getOrThrow<number>('WS_REPLICA_MAX_LAG_MS');
    this.validForMs = Math.max(this.maxLagMs, 2 * HEARTBEAT_INTERVAL_MS);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      // Перехід у `stale` не залежить від завершення проби: зависла проба не лишає сокети відкритими.
      this.update();
      void this.heartbeat();
      void this.probe();
    }, HEARTBEAT_INTERVAL_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * Репліка читає stream і просувається, а свіжа проба це підтверджує. Завислість рахується в
   * момент виклику, а не береться з кешу: `/ready` і upgrade не повинні чекати наступного тіку.
   * Після завислості репліка лишається поза пулом ще `RECOVER_AFTER_MS`.
   */
  healthy(): boolean {
    return this.reader.ready && !this.isStale() && !this.latched;
  }

  onHeartbeat(handler: (instrument: string, seq: string) => void): () => void {
    this.heartbeats.add(handler);
    return () => this.heartbeats.delete(handler);
  }

  /** Викликається один раз при переході в `stale`; сокети тоді розривають, а не лишають `live`. */
  onStale(handler: () => void): () => void {
    this.staleHandlers.add(handler);
    return () => this.staleHandlers.delete(handler);
  }

  /** `last_applied_seq` в PG мінус seq, який роздала репліка, для метрики `ws_replica_lag_seq`. */
  lag(): ReadonlyMap<string, bigint> {
    return this.lags;
  }

  private isStale(): boolean {
    const now = performance.now();
    return [...this.trackers.values()].some((tracker) => tracker.isStale(now));
  }

  private async heartbeat(): Promise<void> {
    if (this.beating || !this.reader.ready) return;
    this.beating = true;
    try {
      let rows: { instrument: string; last_applied_seq: string }[];
      try {
        rows = await this.source.query('SELECT instrument, last_applied_seq FROM instrument_state');
      } catch (error) {
        // Без свіжого seq з PG різниці немає: метрика зникає, а не показує останнє значення.
        // Недоступна БД не доводить зависання репліки: це вирішує проба stream, а не PG.
        this.lags.clear();
        this.warnHeartbeat(error);
        return;
      }
      for (const { instrument, last_applied_seq } of rows) {
        if (!this.instruments.has(instrument)) continue;
        try {
          const applied = BigInt(last_applied_seq);
          const emitted = this.reader.emittedSeq(instrument);
          this.lags.set(instrument, applied > emitted ? applied - emitted : 0n);
          for (const heartbeat of this.heartbeats) heartbeat(instrument, last_applied_seq);
        } catch (error) {
          // Збій відправки не скасовує різницю, яку щойно прочитано з PG, і не зупиняє інші інструменти.
          this.warnHeartbeat(error);
        }
      }
    } finally {
      this.beating = false;
    }
  }

  private warnHeartbeat(error: unknown): void {
    this.logger.warn({
      alert: 'realtime_heartbeat_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  private async probe(): Promise<void> {
    if (this.probing || !this.reader.ready) return;
    this.probing = true;
    try {
      // Завислість, що настала до цієї проби, фіксується до того, як свіжа проба її перекриє.
      this.update();
      const now = performance.now();
      await Promise.all(
        this.reader.streams.map(async (stream) => {
          const cursor = this.reader.cursor(stream);
          let tracker = this.trackers.get(stream);
          if (!tracker) {
            tracker = new LagTracker(this.maxLagMs, this.validForMs, now);
            this.trackers.set(stream, tracker);
          }
          // Збій проби не оновлює вердикт: він спливе за `validForMs`, а не лишиться назавжди.
          const head = await this.reader.head(stream).catch(() => undefined);
          if (head !== undefined) tracker.check(head, cursor, now);
        }),
      );
      this.update();
    } finally {
      this.probing = false;
    }
  }

  private update(): void {
    const now = performance.now();
    if (this.isStale()) {
      this.cleanSince = undefined;
      if (this.latched) return;
      this.latched = true;
      this.logger.error({
        alert: 'ws_replica_stale',
        message: `Replica lags behind the stream or cannot verify it for more than ${this.validForMs} ms`,
      });
      for (const handler of this.staleHandlers) handler();
      return;
    }
    if (!this.latched) return;
    this.cleanSince ??= now;
    if (now - this.cleanSince >= RECOVER_AFTER_MS) {
      this.latched = false;
      this.cleanSince = undefined;
    }
  }
}
