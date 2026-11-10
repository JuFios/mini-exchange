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
      this.pending.set(queue.streams.reduce((sum, { pending }) => sum + pending, 0));
      this.lag.set(queue.streams.reduce((sum, { lag }) => sum + (lag ?? 0), 0));
    }
    return lines.join('\n') + '\n' + (queue ? await this.registry.metrics() : '');
  }
}
