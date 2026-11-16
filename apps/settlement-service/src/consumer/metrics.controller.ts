import { Controller, Get, Header } from '@nestjs/common';
import { Gauge, Registry } from 'prom-client';
import { SettlementConsumer } from './settlement-consumer.service';
import { SettlementStats } from './settlement-stats';

@Controller('metrics')
export class MetricsController {
  private readonly registry = new Registry();
  private readonly pending = new Gauge({
    name: 'settlement_pending',
    help: 'Settlement stream entries pending acknowledgement',
    registers: [this.registry],
  });
  private readonly lag = new Gauge({
    name: 'settlement_stream_lag',
    help: 'Settlement stream entries not yet delivered',
    registers: [this.registry],
  });

  constructor(
    private readonly stats: SettlementStats,
    private readonly consumer: SettlementConsumer,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async metrics() {
    const lines = [
      `settlement_recovery_last_success_timestamp_seconds ${this.stats.recoveryLastSuccess}`,
      `settlement_recovery_caught_up_timestamp_seconds ${this.stats.recoveryCaughtUp}`,
      `settlement_durable_backlog ${this.stats.durableBacklog}`,
      ...Object.entries(this.stats.trades).map(
        ([result, count]) => `settlement_trades_total{result="${result}"} ${count}`,
      ),
      `settlement_dlq_total ${this.stats.deadLettered}`,
      `settlement_trimmed_pending_total ${this.stats.trimmedPending}`,
      `settlement_transient_failures_total ${this.stats.transientFailures}`,
      `settlement_retried_failures_total ${this.stats.retriedFailures}`,
    ];
    // Недоступний Redis не повинен ховати лічильники процесу.
    const queue = await this.consumer.queue().catch(() => undefined);
    if (queue) {
      lines.push(
        `settlement_failures ${queue.failures}`,
        `settlement_dead_letters ${queue.deadLetters}`,
        `settlement_oldest_pending_age_seconds ${Math.max(0, ...queue.streams.map((stream) => stream.oldestPendingAgeSeconds))}`,
      );
      this.pending.set(queue.streams.reduce((sum, { pending }) => sum + pending, 0));
      // null від Redis означає, що lag невідомий (наприклад, після видалення недоставленого
      // запису). Нуль ховав би відставання, тож метрика стає NaN.
      const lags = queue.streams.map(({ lag }) => lag);
      this.lag.set(
        lags.includes(null) ? NaN : lags.reduce<number>((sum, lag) => sum + (lag ?? 0), 0),
      );
    }
    return lines.join('\n') + '\n' + (queue ? await this.registry.metrics() : '');
  }
}
