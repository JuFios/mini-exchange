import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { LagTracker } from './replica-lag';

export const HEARTBEAT_INTERVAL_MS = 2000;

/**
 * Раз на HEARTBEAT_INTERVAL_MS читає `last_applied_seq` з PG і роздає його як heartbeat:
 * клієнт порівнює його з тим, що отримав, тож завислий XREAD-цикл репліки не лишає клієнтів
 * `live` на застарілій книзі. Окремо стежить, чи репліка просувається за кожним stream, який опублікував relay.
 */
@Injectable()
export class ReplicaLagMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReplicaLagMonitor.name);
  private readonly trackers = new Map<string, LagTracker>();
  private readonly heartbeats = new Set<(instrument: string, seq: string) => void>();
  private readonly staleHandlers = new Set<() => void>();
  private readonly lags = new Map<string, bigint>();
  private readonly maxLagMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stale = false;

  constructor(
    config: ConfigService,
    private readonly source: DataSource,
    private readonly reader: RealtimeStreamReader,
    private readonly instruments: InstrumentCatalog,
  ) {
    this.maxLagMs = config.getOrThrow<number>('WS_REPLICA_MAX_LAG_MS');
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_INTERVAL_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Репліка читає stream і просувається; інакше LB має її зняти (`/ready`). */
  healthy(): boolean {
    return this.reader.ready && !this.stale;
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

  private async tick(): Promise<void> {
    if (this.running || !this.reader.ready) return;
    this.running = true;
    try {
      const rows: { instrument: string; last_applied_seq: string }[] = await this.source.query(
        'SELECT instrument, last_applied_seq FROM instrument_state',
      );
      const now = performance.now();
      // Heartbeat іде з PG до будь-яких звернень до Redis: його мета — пережити поганий stream.
      for (const { instrument, last_applied_seq } of rows) {
        if (!this.instruments.has(instrument)) continue;
        const applied = BigInt(last_applied_seq);
        const emitted = this.reader.emittedSeq(instrument);
        this.lags.set(instrument, applied > emitted ? applied - emitted : 0n);
        for (const heartbeat of this.heartbeats) heartbeat(instrument, last_applied_seq);
      }
      const stalled = await Promise.all(
        this.reader.streams.map(async (stream) => {
          const cursor = this.reader.cursor(stream);
          const tracker = this.trackers.get(stream) ?? new LagTracker(this.maxLagMs);
          this.trackers.set(stream, tracker);
          // Збій перевірки не доводить ні зависання, ні наздоганяння: лишається останній відомий стан.
          // Недоступний Redis ловить `/ready` через lease.
          const head = await this.reader.head(stream).catch(() => undefined);
          return head === undefined ? tracker.stale : tracker.check(head, cursor, now).stale;
        }),
      );
      const anyStale = stalled.some(Boolean);
      this.update(anyStale);
    } catch (error) {
      // Недоступна БД не доводить зависання репліки; прийом у цей час відхиляється й так.
      this.logger.warn({
        alert: 'realtime_heartbeat_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private update(stale: boolean): void {
    if (stale && !this.stale) {
      this.logger.error({
        alert: 'ws_replica_stale',
        message: `Replica made no progress for more than ${this.maxLagMs} ms`,
      });
      for (const handler of this.staleHandlers) handler();
    }
    this.stale = stale;
  }
}
