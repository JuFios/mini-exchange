import { EngineOutboxClient } from './engine-outbox.client';
import { DataSource } from 'typeorm';
import { ASSETS } from '../ledger/amount';
import { traced } from '../observability/trace-context';
import { Injectable, Logger } from '@nestjs/common';
import { ReservationsService } from '../reservations/reservations.service';
import { WalletReader } from '../ledger/wallet-reader';
import { TradesService } from '../trades/trades.service';
import { WalletPublisher } from '../wallets/wallet-publisher';
import { PayloadConflictError } from './failure-kind';
import { parseSettlementEvent } from './settlement-event';
import { SettlementStats } from './settlement-stats';

@Injectable()
export class SettlementEventHandler {
  private readonly logger = new Logger(SettlementEventHandler.name);
  constructor(
    private readonly trades: TradesService,
    private readonly reservations: ReservationsService,
    private readonly wallets: WalletReader,
    private readonly publisher: WalletPublisher,
    private readonly stats: SettlementStats,
    private readonly outbox: EngineOutboxClient,
    private readonly source: DataSource,
  ) {}

  async recover(stopped: () => boolean): Promise<void> {
    this.stats.durableBacklog = 0;
    for (const instrument of ASSETS.filter((asset) => asset !== 'USD')) {
      if (stopped()) return;
      const [progress]: { position: string }[] = await this.source.query(
        'SELECT position FROM settlement_progress WHERE instrument=$1',
        [instrument],
      );
      const events = await this.outbox.page(instrument, progress?.position ?? '0');
      this.stats.durableBacklog += events.length;
      for (const event of events) {
        if (stopped()) return;
        await this.handle(`outbox:${event.position}`, event.envelope, 'recovery');
        // Фінансовий COMMIT уже відбувся. Падіння до цього запису дає ідемпотентний повтор.
        // Кожен прохід підтверджує лише свій повністю оброблений префікс.
        await this.source.query(
          `INSERT INTO settlement_progress(instrument,position) VALUES($1,$2)
           ON CONFLICT(instrument) DO UPDATE
           SET position=GREATEST(settlement_progress.position,EXCLUDED.position),
               updated_at=clock_timestamp()`,
          [instrument, event.position],
        );
      }
    }
    this.stats.recoveryLastSuccess = Date.now() / 1000;
  }

  /** Redis delivery публікує wallet.updated до ACK. Recovery читає вже перевірену сторінку outbox. */
  async handle(
    streamId: string,
    envelope: string | undefined,
    mode: 'stream' | 'recovery' = 'stream',
  ): Promise<void> {
    const canonical = mode === 'recovery' ? envelope : (await this.outbox.event(envelope)).envelope;
    const event = parseSettlementEvent(canonical);
    if (event.type === 'order.closed') {
      const { orderId, releasedAmount, userId, releasedAsset } = event.closed;
      await this.reservations.release(orderId, BigInt(releasedAmount), false, {
        userId,
        asset: releasedAsset,
      });
      if (mode === 'recovery') return;
      // Як і для угоди, повторна доставка теж публікує стан: без цього збій XADD після COMMIT
      // лишав би клієнту старий резерв до перепідключення.
      const released = await this.reservations.closedRelease(orderId);
      if (!released) return;
      for (const balance of await this.wallets.read([released.wallet]))
        await this.publisher.publish({ ...balance, entryId: released.entryId });
      return;
    }
    const { trade } = event;
    const fields = { tradeId: trade.tradeId, instrument: trade.instrument };
    await traced('settle trade', event.traceparent, fields, async () => {
      const result = await this.trades.settle(trade, streamId, event.traceId);
      this.stats.trades[result.status]++;
      this.logger.log({ event: 'settlement.trade', ...fields, result: result.status });
      if (result.status === 'conflict') throw new PayloadConflictError('Trade payload conflict');
      if (mode === 'recovery') return;

      // Повторна доставка теж публікує стан: попередній прогін міг впасти між COMMIT і XADD.
      const balances = await this.wallets.read([
        { userId: trade.buyerUserId.toLowerCase(), asset: trade.baseAsset },
        { userId: trade.buyerUserId.toLowerCase(), asset: trade.quoteAsset },
        { userId: trade.sellerUserId.toLowerCase(), asset: trade.baseAsset },
        { userId: trade.sellerUserId.toLowerCase(), asset: trade.quoteAsset },
      ]);
      for (const balance of balances)
        await this.publisher.publish({ ...balance, entryId: result.entryId });
    });
  }
}
