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
  ) {}

  /** Повертається лише після COMMIT і публікації wallet.updated: після цього запис можна підтверджувати. */
  async handle(streamId: string, envelope: string | undefined): Promise<void> {
    const event = parseSettlementEvent(envelope);
    if (event.type === 'order.closed') {
      const { orderId, releasedAmount } = event.closed;
      await this.reservations.release(orderId, BigInt(releasedAmount), false);
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
