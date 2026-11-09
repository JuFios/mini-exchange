import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ReservationClient } from './reservation.client';

const BATCH_SIZE = 8;
const ALERT_AFTER_MS = 10 * 60 * 1000;

interface SweepSettings {
  intervalMs: number;
  expireAfterMs: number;
  claimMs: number;
}

interface ReleaseClaim {
  order_id: string;
  claim: string;
  age_ms: string;
}

interface ClosedClaim extends ReleaseClaim {
  id: string;
  amount: string;
}

@Injectable()
export class ReservationSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReservationSweeper.name);
  private readonly settings?: SweepSettings;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  releaseFailures = 0;

  constructor(
    private readonly source: DataSource,
    private readonly reservations: ReservationClient,
    config: ConfigService,
  ) {
    if (config.getOrThrow('RESERVATIONS_ENABLED')) {
      const intervalMs = config.getOrThrow<number>('RESERVATION_SWEEP_INTERVAL_MS');
      this.settings = {
        intervalMs,
        expireAfterMs: config.getOrThrow<number>('RESERVATION_SWEEP_AFTER_MS'),
        claimMs: 2 * config.getOrThrow<number>('RESERVATION_TIMEOUT_MS') + intervalMs,
      };
    }
  }

  onApplicationBootstrap(): void {
    if (this.settings) this.schedule(this.settings);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(settings: SweepSettings): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = Promise.allSettled([
        this.sweepAbandoned(settings),
        this.sweepClosed(settings.claimMs),
      ]).then((results) => {
        if (results.some((result) => result.status === 'rejected'))
          this.logger.error({ alert: 'reservation_sweep_failed' });
        this.schedule(settings);
      });
    }, settings.intervalMs).unref();
  }

  private async sweepAbandoned({ expireAfterMs, claimMs }: SweepSettings): Promise<void> {
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
      [expireAfterMs, BATCH_SIZE, claimMs],
    );
    await Promise.allSettled(
      claims.map((claim) => this.releaseAbandoned(claim, expireAfterMs)),
    ).then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        this.logger.error({ alert: 'reservation_sweep_failed' });
    });
  }

  private async releaseAbandoned(
    { order_id: orderId, claim, age_ms: ageMs }: ReleaseClaim,
    expireAfterMs: number,
  ): Promise<void> {
    try {
      await this.reservations.release(orderId);
    } catch {
      const [, updated] = await this.source.query(
        `UPDATE order_requests SET release_attempts=release_attempts+1, updated_at=clock_timestamp(),
           release_due_at=clock_timestamp()
         WHERE order_id=$1 AND status='releasing' AND release_due_at=$2::timestamptz`,
        [orderId, claim],
      );
      if (updated) this.recordFailure(orderId, Number(ageMs) - expireAfterMs);
      return;
    }
    await this.source.query(
      `UPDATE order_requests SET status='expired', updated_at=clock_timestamp(), release_due_at=NULL
       WHERE order_id=$1 AND status='releasing' AND release_due_at=$2::timestamptz`,
      [orderId, claim],
    );
  }

  private async sweepClosed(claimMs: number): Promise<void> {
    // Подія створюється разом зі зміною заявки. Після краху інша репліка дочекається claim.
    const [claims]: [ClosedClaim[], number] = await this.source.query(
      `WITH due AS (
         SELECT id FROM outbox
         WHERE type='order.closed' AND reservation_released_at IS NULL
           AND COALESCE(reservation_release_due_at, created_at) <= now()
         ORDER BY COALESCE(reservation_release_due_at, created_at), id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox o SET reservation_release_due_at=clock_timestamp() + ($2 * interval '1 millisecond')
       FROM due WHERE o.id=due.id
       RETURNING o.id, o.payload->>'orderId' AS order_id, o.payload->>'releasedAmount' AS amount,
         o.reservation_release_due_at::text AS claim,
         EXTRACT(EPOCH FROM (clock_timestamp() - o.created_at)) * 1000 AS age_ms`,
      [BATCH_SIZE, claimMs],
    );
    const results = await Promise.allSettled(claims.map((claim) => this.releaseClosed(claim)));
    if (results.some((result) => result.status === 'rejected'))
      this.logger.error({ alert: 'reservation_sweep_failed' });
  }

  private async releaseClosed({
    id,
    order_id: orderId,
    amount,
    claim,
    age_ms: ageMs,
  }: ClosedClaim) {
    const released = await this.reservations.release(orderId, amount).then(
      () => true,
      () => false,
    );
    const [, updated] = await this.source.query(
      `UPDATE outbox
       SET reservation_released_at=CASE WHEN $3 THEN clock_timestamp() END,
           reservation_release_due_at=CASE WHEN NOT $3 THEN clock_timestamp() END
       WHERE id=$1 AND reservation_released_at IS NULL AND reservation_release_due_at=$2::timestamptz`,
      [id, claim, released],
    );
    if (!released && updated) this.recordFailure(orderId, Number(ageMs));
  }

  private recordFailure(orderId: string, ageMs: number): void {
    this.releaseFailures++;
    if (ageMs >= ALERT_AFTER_MS) this.logger.error({ alert: 'reservation_release_stuck', orderId });
  }
}
