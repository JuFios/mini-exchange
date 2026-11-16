import { EngineOutboxClient } from './engine-outbox.client';
import { DataSource } from 'typeorm';
import { boundedRead, boundedTransaction } from '../database/bounded-read';
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

// Розмір сторінки `GET /internal/outbox/page` в engine. Коротша сторінка означає, що курсор
// після неї дійшов до кінця committed журналу на момент читання.
const OUTBOX_PAGE_LIMIT = 50;
// Бюджет одного кроку recovery: читання курсора й сторінки або одна подія з checkpoint.
const RECOVERY_STEP_MS = 5000;

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
    const failures: string[] = [];
    let caughtUp = true;
    for (const instrument of ASSETS.filter((asset) => asset !== 'USD')) {
      if (stopped()) return;
      try {
        caughtUp = (await this.recoverInstrument(instrument, stopped)) && caughtUp;
      } catch (error) {
        // Курсор цього інструмента лишається перед проблемою; інші інструменти просуваються.
        failures.push(`${instrument}: ${(error as Error).message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('; '));
    if (stopped()) return;
    const now = Date.now() / 1000;
    this.stats.recoveryLastSuccess = now;
    // Live delivery не рухає курсор, тож під торгівлею сторінка рідко порожня. Відставання
    // означає лише курсор, який не дочитує журнал до кінця.
    if (caughtUp) this.stats.recoveryCaughtUp = now;
  }

  /** Повертає true, якщо курсор дійшов до кінця журналу інструмента на момент читання. */
  private async recoverInstrument(instrument: string, stopped: () => boolean): Promise<boolean> {
    const pageSignal = AbortSignal.timeout(RECOVERY_STEP_MS);
    const [progress]: { position: string }[] = await boundedRead(this.source, pageSignal, (db) =>
      db.query('SELECT position FROM settlement_progress WHERE instrument=$1', [instrument]),
    );
    const events = await this.outbox.page(instrument, progress?.position ?? '0', pageSignal);
    this.stats.durableBacklog += events.length;
    for (const event of events) {
      if (stopped()) return false;
      // Окремий бюджет на подію: повільний ledger просуває курсор подія за подією, а не
      // переривається щоразу посеред сторінки.
      const signal = AbortSignal.timeout(RECOVERY_STEP_MS);
      await this.handle(`outbox:${event.position}`, event.envelope, signal);
      // Фінансовий COMMIT уже відбувся. Падіння до цього запису дає ідемпотентний повтор.
      await boundedTransaction(this.source, signal, (db) =>
        db.query(
          `INSERT INTO settlement_progress(instrument,position) VALUES($1,$2)
         ON CONFLICT(instrument) DO UPDATE
         SET position=GREATEST(settlement_progress.position,EXCLUDED.position),
             updated_at=clock_timestamp()`,
          [instrument, event.position],
        ),
      );
    }
    return events.length < OUTBOX_PAGE_LIMIT;
  }

  /** Redis delivery публікує wallet.updated до ACK. Recovery читає вже перевірену сторінку outbox. */
  async handle(
    streamId: string,
    envelope: string | undefined,
    recoverySignal?: AbortSignal,
  ): Promise<void> {
    const canonical = recoverySignal ? envelope : (await this.outbox.event(envelope)).envelope;
    const event = parseSettlementEvent(canonical);
    if (event.type === 'order.closed') {
      const { orderId, releasedAmount, userId, releasedAsset } = event.closed;
      await this.reservations.release(
        orderId,
        BigInt(releasedAmount),
        false,
        {
          userId,
          asset: releasedAsset,
        },
        recoverySignal,
      );
      if (recoverySignal) return;
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
      const result = await this.trades.settle(trade, streamId, event.traceId, recoverySignal);
      this.stats.trades[result.status]++;
      this.logger.log({ event: 'settlement.trade', ...fields, result: result.status });
      if (result.status === 'conflict') throw new PayloadConflictError('Trade payload conflict');
      if (recoverySignal) return;

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
