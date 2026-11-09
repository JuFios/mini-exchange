import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ReservationClient } from './reservation.client';

const BATCH_SIZE = 8;
const ALERT_AFTER_MS = 10 * 60 * 1000;

interface ReleaseClaim {
  order_id: string;
  claim: string;
  age_ms: string;
}

@Injectable()
export class ReservationSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReservationSweeper.name);
  private readonly intervalMs: number;
  private readonly expireAfterMs: number;
  private readonly claimMs: number;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  releaseFailures = 0;

  constructor(
    private readonly source: DataSource,
    private readonly reservations: ReservationClient,
    private readonly config: ConfigService,
  ) {
    this.intervalMs = config.getOrThrow('RESERVATION_SWEEP_INTERVAL_MS');
    this.expireAfterMs = config.getOrThrow('RESERVATION_SWEEP_AFTER_MS');
    this.claimMs = 2 * config.getOrThrow<number>('RESERVATION_TIMEOUT_MS') + this.intervalMs;
  }

  onApplicationBootstrap(): void {
    if (this.config.getOrThrow('RESERVATIONS_ENABLED')) this.schedule();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.sweep()
        .catch(() => this.logger.error({ alert: 'reservation_sweep_failed' }))
        .then(() => this.schedule());
    }, this.intervalMs).unref();
  }

  private async sweep(): Promise<void> {
    // Коміт відсікає TX2 прийому до першого HTTP. Строк claim дає іншій репліці продовжити після краху.
    const [claims]: [ReleaseClaim[], number] = await this.source.query(
      `WITH due AS (
         SELECT order_id FROM order_requests
         WHERE (status='reserving' AND created_at <= now() - ($1 * interval '1 millisecond'))
            OR (status='releasing' AND (release_due_at IS NULL OR release_due_at <= now()))
         ORDER BY COALESCE(release_due_at, created_at), order_id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE order_requests r SET status='releasing', updated_at=clock_timestamp(),
         release_due_at=clock_timestamp() + ($3 * interval '1 millisecond')
       FROM due WHERE r.order_id=due.order_id
       RETURNING r.order_id, r.release_due_at::text AS claim,
         EXTRACT(EPOCH FROM (clock_timestamp() - r.created_at)) * 1000 AS age_ms`,
      [this.expireAfterMs, BATCH_SIZE, this.claimMs],
    );
    await Promise.allSettled(claims.map((claim) => this.release(claim))).then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        this.logger.error({ alert: 'reservation_sweep_failed' });
    });
  }

  private async release({ order_id: orderId, claim, age_ms: ageMs }: ReleaseClaim): Promise<void> {
    try {
      await this.reservations.release(orderId);
    } catch {
      const [, updated] = await this.source.query(
        `UPDATE order_requests SET release_attempts=release_attempts+1, updated_at=clock_timestamp(),
           release_due_at=clock_timestamp()
         WHERE order_id=$1 AND status='releasing' AND release_due_at=$2::timestamptz`,
        [orderId, claim],
      );
      if (updated) {
        this.releaseFailures++;
        if (Number(ageMs) >= this.expireAfterMs + ALERT_AFTER_MS)
          this.logger.error({ alert: 'reservation_release_stuck', orderId });
      }
      return;
    }
    await this.source.query(
      `UPDATE order_requests SET status='expired', updated_at=clock_timestamp(), release_due_at=NULL
       WHERE order_id=$1 AND status='releasing' AND release_due_at=$2::timestamptz`,
      [orderId, claim],
    );
  }
}
