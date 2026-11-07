import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Book } from '../matching/book';
import { Command } from '../matching/engine';
import { formatPrice, formatQuantity } from '../matching/decimal';
import { Order, OrderStatus } from '../orders/entities/order.entity';
import { OrderBookService } from '../orders/order-book.service';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { BookLoader, counters } from './book-loader';
import { bookOrder, CommandRow } from './command';
import { CommandApplier, toRejectedInternal, WorkerResult } from './command-applier';
import { LocalOwnership } from './local-ownership';
import { PgNotifications } from './pg-notifications';

interface OwnedBook { book: Book; seq: string; halted: boolean }

@Injectable()
export class InstrumentWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InstrumentWorker.name);
  private readonly owned = new Map<string, OwnedBook>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly gaps = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly wake = (instrument: string) => { void this.kick(instrument); };

  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
    private readonly books: OrderBookService,
    private readonly loader: BookLoader,
    private readonly ownership: LocalOwnership,
    private readonly notifications: PgNotifications,
    private readonly applier: CommandApplier,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.ownership.enabled()) return;
    for (const { symbol } of this.catalog.list()) {
      await this.reload(symbol);
    }
    this.notifications.commandListeners.add(this.wake);
    await this.poll();
  }

  private async reload(instrument: string): Promise<void> {
    const owned = await this.source.transaction(async (db) => {
      await db.query("SET LOCAL lock_timeout='3s'");
      return this.loader.load(db, instrument);
    });
    this.owned.set(instrument, owned);
    this.books.commit(instrument, owned.book, owned.seq);
  }

  private async poll(): Promise<void> {
    await Promise.all([...this.owned.keys()].map((symbol) => this.kick(symbol)));
    if (!this.stopped) this.timer = setTimeout(() => { void this.poll(); }, this.config.getOrThrow('COMMAND_POLL_INTERVAL_MS'));
  }

  async kick(instrument: string): Promise<void> {
    if (this.stopped || !this.owned.has(instrument)) return;
    const running = this.running.get(instrument);
    if (running) return running;
    const task = this.drain(instrument).catch(async (error: unknown) => {
      this.logger.error({ alert: 'engine_apply_failed', instrument, error: error instanceof Error ? error.message : 'Unknown error' });
      // COMMIT міг відбутися без підтвердження: наступна спроба відновить книгу з БД.
      try { await this.reload(instrument); } catch { /* Наступний poll повторить recovery після відновлення PostgreSQL. */ }
    }).finally(() => { this.running.delete(instrument); });
    this.running.set(instrument, task);
    return task;
  }

  private async drain(instrument: string): Promise<void> {
    for (let count = 0; count < 100 && !this.stopped; count++) {
      const owned = this.owned.get(instrument)!;
      if (owned.halted) return;
      const [row]: CommandRow[] = await this.source.query(`SELECT * FROM order_commands
        WHERE instrument=$1 AND seq>$2 ORDER BY seq LIMIT 1`, [instrument, owned.seq]);
      if (!row) return;
      if (BigInt(row.seq) !== BigInt(owned.seq) + 1n) {
        const since = this.gaps.get(instrument) ?? performance.now();
        this.gaps.set(instrument, since);
        if (performance.now() - since >= this.config.getOrThrow<number>('SEQ_GAP_ALERT_MS')) {
          await this.source.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [instrument]);
          owned.halted = true;
          this.logger.error({ alert: 'engine_seq_gap', instrument, seq: row.seq });
        }
        return;
      }
      this.gaps.delete(instrument);
      const result = await this.source.transaction((db) => this.applyOne(db, owned, row));
      if (!result) { owned.halted = true; return; }
      owned.book = result.book;
      owned.seq = row.seq;
      this.books.commit(instrument, result.book, row.seq);
    }
  }

  private async applyOne(db: EntityManager, owned: OwnedBook, row: CommandRow): Promise<WorkerResult | undefined> {
    await db.query("SET LOCAL lock_timeout='3s'");
    const [state] = await db.query('SELECT * FROM instrument_state WHERE instrument=$1 FOR UPDATE', [row.instrument]);
    if (state.status === 'halted') return;
    if (state.last_applied_seq !== owned.seq) throw new Error('Committed book sequence changed');
    const target = await db.getRepository(Order).findOneByOrFail({ id: row.order_id });
    const command: Command = row.type === 'submit' ? {
      type: 'submit', instrument: row.instrument, seq: BigInt(row.seq), acceptedAt: row.accepted_at.toISOString(),
      order: bookOrder(target),
    } : {
      type: 'cancel', orderId: target.id,
      ...((target.status === 'filled' || target.status === 'cancelled') && { terminalStatus: target.status }),
    };
    let result: WorkerResult;
    try { result = this.applier.apply(owned.book, command); } catch {
      result = toRejectedInternal(owned.book, bookOrder(target), target.status === 'filled' || target.status === 'cancelled');
      this.logger.error({ alert: 'engine_command_rejected', instrument: row.instrument, seq: row.seq, orderId: row.order_id });
    }
    for (const change of result.orderChanges) {
      const previous = change.id === target.id ? target : await db.getRepository(Order).findOneByOrFail({ id: change.id });
      const updated = await db.getRepository(Order).update({ id: change.id, version: previous.version }, {
        status: change.status as OrderStatus, remainingQuantity: formatQuantity(change.remaining),
        filledQuantity: formatQuantity(change.quantity - change.remaining), cancelReason: change.cancelReason ?? null,
        version: previous.version! + 1, updatedAt: new Date(),
      });
      if (updated.affected !== 1) throw new Error('Order version changed');
    }
    for (const [index, fill] of result.trades.entries()) {
      const buy = await db.getRepository(Order).findOneByOrFail({ id: fill.buyOrderId });
      const sell = await db.getRepository(Order).findOneByOrFail({ id: fill.sellOrderId });
      await db.query(`INSERT INTO trades (trade_id,instrument,seq,fill_index,price,quantity,quote_amount,
        buyer_order_id,seller_order_id,buyer_user_id,seller_user_id,taker_side,executed_at,trace_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [fill.tradeId, row.instrument, row.seq, index, formatPrice(fill.price), formatQuantity(fill.quantity),
        (fill.price * fill.quantity).toString(), buy.id, sell.id, buy.ownerId, sell.ownerId,
        target.side, row.accepted_at, row.traceparent?.split('-')[1] ?? null]);
    }
    if (result.outcome === 'rejected_internal') {
      await this.rejectionEvents(db, row, target, result);
    }
    await db.query(`UPDATE order_commands SET applied_at=now(),result=$3 WHERE instrument=$1 AND seq=$2`,
      [row.instrument, row.seq, { status: result.outcome, tradeIds: result.trades.map(({ tradeId }) => tradeId), epoch: state.owner_epoch, instance: this.config.getOrThrow('INSTANCE_ID') }]);
    const totals = counters(result.book);
    const updated = await db.query(`UPDATE instrument_state
      SET last_applied_seq=$2,resting_count=$3,resting_quantity=$4,
          resting_bid_count=$6,resting_ask_count=$7,resting_bid_lots=$8,resting_ask_lots=$9
      WHERE instrument=$1 AND last_applied_seq=$5 RETURNING instrument`,
    [row.instrument, row.seq, totals.count, totals.quantity, owned.seq, totals.bidCount, totals.askCount, totals.bidLots, totals.askLots]);
    if (updated[1] !== 1) throw new Error('Committed sequence changed');
    await db.query("SELECT pg_notify('order_applied',$1)", [`${row.order_id}:${row.seq}`]);
    return result;
  }

  private async rejectionEvents(db: EntityManager, row: CommandRow, target: Order, result: WorkerResult): Promise<void> {
    const events: [string, string, object][] = [
      [`exchange:market:{${row.instrument}}`, 'book.delta', { instrument: row.instrument, seq: row.seq, changes: result.levelChanges.map((level) => ({ side: level.side === 'buy' ? 'bid' : 'ask', price: formatPrice(level.price), quantity: level.quantity === 0n ? '0' : formatQuantity(level.quantity), orders: level.orders })) }],
      ...result.closed.map((closed): [string, string, object] => [
        `exchange:settlement:{${row.instrument}}`, 'order.closed', {
          orderId: target.id, userId: target.ownerId, instrument: row.instrument, side: target.side,
          reason: 'rejected', releasedAsset: this.catalog.list().find(({ symbol }) => symbol === row.instrument)![target.side === 'buy' ? 'quoteAsset' : 'baseAsset'],
          releasedAmount: closed.releasedAmount.toString(), seq: row.seq,
        },
      ]),
    ];
    for (const [stream, type, payload] of events) {
      await db.query(`INSERT INTO outbox(event_id,stream,type,version,instrument,seq,payload,traceparent)
        VALUES ($1,$2,$3,1,$4,$5,$6,$7)`, [randomUUID(), stream, type, row.instrument, row.seq, payload, row.traceparent]);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.notifications.commandListeners.delete(this.wake);
    await Promise.all(this.running.values());
  }
}
