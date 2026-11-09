import { Controller, Get, Header } from '@nestjs/common';
import { SettlementConsumer } from './settlement-consumer.service';
import { SettlementStats } from './settlement-stats';

@Controller('metrics')
export class MetricsController {
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
      lines.push(
        `settlement_pending ${queue.streams.reduce((sum, { pending }) => sum + pending, 0)}`,
        `settlement_stream_lag ${queue.streams.reduce((sum, { lag }) => sum + (lag ?? 0), 0)}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}
