import { activeTraceparent, traced } from '../observability/trace-context';
import { commandsApplied, commandSeconds, ordersRejected, seqGaps } from '../observability/metrics';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import type { EngineEvent, TradeExecutedV1, TradePublicV1 } from '../contracts/events';
import { Book } from '../matching/book';
import { Command } from '../matching/engine';
import { formatPrice, formatQuantity } from '../matching/decimal';
import { Order } from '../orders/entities/order.entity';
import { OrderBookService } from '../orders/order-book.service';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { BookLoader, counters } from './book-loader';
import { bookOrder, CommandRow } from './command';
import { CommandApplier, toRejectedInternal, WorkerResult } from './command-applier';
import { OwnershipCoordinator } from '../ownership/ownership-coordinator';
import { InstrumentLease } from '../ownership/lease-manager';
import { FencedOutError, haltInstrument, lockEpoch } from '../ownership/fencing';
import { ChaosHooks } from '../chaos/chaos-hooks';
import { PgNotifications } from './pg-notifications';
import { insertOutboxEvents } from '../outbox/outbox-events';

// Resume і shutdown чекають на поточний drain, тому один прохід обмежений часом.
// Решту backlog забере наступний poll або NOTIFY.
const DRAIN_BUDGET_MS = 1000;
// Renew у Redis не залежить від PostgreSQL: запит у мертву мережу тримав би lease без роботи.
// Рахується час без прогресу, а не вся операція: великий sweep легально триває довше.
// Межа більша за очікування одного кроку: черга пулу 10 с, lock 3 с, statement 10 с.
const WORKER_STALL_MS = 30000;
// Довше за інтервал acquire: резерв встигає забрати lease раніше за відрізаного власника.
const STALL_BACK_OFF_MS = 5000;

interface OwnedBook {
  epoch: string;
  lease: InstrumentLease;
  book: Book;
  seq: string;
  halted: boolean;
}

@Injectable()
export class InstrumentWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InstrumentWorker.name);
  private readonly owned = new Map<string, OwnedBook>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly gaps = new Map<string, number>();
  private readonly progress = new WeakMap<InstrumentLease, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly wake = (instrument: string) => {
    void this.kick(instrument);
  };

  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
    private readonly books: OrderBookService,
    private readonly loader: BookLoader,
    private readonly ownership: OwnershipCoordinator,
    private readonly chaos: ChaosHooks,
    private readonly notifications: PgNotifications,
    private readonly applier: CommandApplier,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.ownership.leases.beforeShutdown.add(() => this.onModuleDestroy());
    this.ownership.leases.lost.add((instrument) => {
      this.owned.delete(instrument);
      this.books.forget(instrument);
    });
    if (!this.config.getOrThrow<boolean>('ENGINE_WORKER_ENABLED')) return;
    this.notifications.resumeListeners.add(this.resume);
    this.notifications.commandListeners.add(this.wake);
    await this.poll(true);
  }

  // Одне завантаження на інструмент: poll і повтор після збою drain не змагаються за lease.
  private reload(instrument: string): Promise<void> {
    const current = this.loading.get(instrument);
    if (current) return current;
    const task = this.load(instrument).finally(() => {
      if (this.loading.get(instrument) === task) this.loading.delete(instrument);
    });
    this.loading.set(instrument, task);
    return task;
  }

  private async load(instrument: string): Promise<void> {
    const lease = await this.ownership.leases.acquire(instrument);
    if (!lease) return;
    await this.install(instrument, lease);
  }

  // Єдиний шлях запису результату recovery. Помилка не доводить, що COMMIT не застосувався,
  // тому локальний стан відкидається, а наступний poll читає фактичний стан із БД.
  private async install(
    instrument: string,
    lease: InstrumentLease,
    resume = false,
  ): Promise<OwnedBook> {
    try {
      const owned = await this.bounded(
        instrument,
        lease,
        this.ownership.recover(instrument, lease, resume),
      );
      this.owned.set(instrument, owned);
      if (owned.quarantined) this.books.quarantine(instrument);
      else this.books.commit(instrument, owned.book, owned.seq);
      return owned;
    } catch (error) {
      // Після збою автоматичного recovery даємо резерву час узяти lease.
      // Ручний resume з непевним COMMIT одразу повертається до читання стану з PG.
      this.ownership.leases.drop(lease, resume ? 0 : STALL_BACK_OFF_MS);
      throw error;
    }
  }

  // Застарілий запис після відновлення мережі не пройде fencing; тут звільняється лише lease.
  private bounded<T>(
    instrument: string,
    lease: InstrumentLease | undefined,
    work: Promise<T>,
  ): Promise<T> {
    if (!lease) return work;
    this.beat(lease);
    let timer: NodeJS.Timeout;
    const stalled = new Promise<never>((_resolve, reject) => {
      const check = () => {
        const idle = performance.now() - this.progress.get(lease)!;
        if (idle < WORKER_STALL_MS) {
          timer = setTimeout(check, WORKER_STALL_MS - idle);
          return;
        }
        this.logger.error({ alert: 'engine_worker_stalled', instrument });
        this.ownership.leases.drop(lease, STALL_BACK_OFF_MS);
        reject(new FencedOutError());
      };
      timer = setTimeout(check, WORKER_STALL_MS);
    });
    return Promise.race([work, stalled]).finally(() => clearTimeout(timer));
  }

  private beat(lease: InstrumentLease): void {
    this.progress.set(lease, performance.now());
  }

  // Великий sweep триває довго: застарілий власник має швидко відпустити блокування рядка.
  private step(lease: InstrumentLease): void {
    this.ownership.leases.assert(lease);
    this.beat(lease);
  }

  private readonly resume = (request: { instrument: string; id: string }) => {
    const owned = this.owned.get(request.instrument);
    if (!owned || !this.ownership.leases.valid(owned.lease)) return;
    const previous = this.running.get(request.instrument);
    const task = (async () => {
      await this.notifications.ackResume(request.id).catch(() => undefined);
      await previous;
      const recovered = await this.install(request.instrument, owned.lease, true);
      await this.notifications.answerResume(request.id, !recovered.halted);
    })()
      .catch((error: unknown) => {
        this.logger.error({
          alert: 'engine_resume_failed',
          instrument: request.instrument,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      })
      .finally(() => {
        if (this.running.get(request.instrument) === task) this.running.delete(request.instrument);
      });
    this.running.set(request.instrument, task);
  };

  // Наступний poll планується до початку роботи: довгий drain або повільний recovery одного
  // інструмента не відкладає захоплення lease іншого, інакше failover перевищить заявлені 7–10 с.
  private poll(initial = false): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.timer = setTimeout(() => {
      void this.poll();
    }, this.config.getOrThrow('COMMAND_POLL_INTERVAL_MS'));
    return this.sweep(initial);
  }

  // Старт чекає на перший drain; наступні poll його лише запускають, щоб не накопичувати
  // очікувачів поки drain триває.
  private async sweep(waitForDrain: boolean): Promise<void> {
    await Promise.all(
      this.catalog.list().map(async ({ symbol }) => {
        if (!this.owned.has(symbol) && !this.loading.has(symbol)) {
          try {
            await this.reload(symbol);
          } catch (error) {
            // Наступний poll повторить acquire; причину видно в журналі.
            this.logger.warn({
              alert: 'engine_reload_failed',
              instrument: symbol,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
        }
        const drain = this.kick(symbol);
        if (waitForDrain) await drain;
      }),
    );
  }

  async kick(instrument: string): Promise<void> {
    if (this.stopped || !this.owned.has(instrument)) return;
    const running = this.running.get(instrument);
    if (running) return running;
    // Lease цього drain: до завершення запису owned міг змінитися на нову епоху.
    const lease = this.owned.get(instrument)?.lease;
    const task = this.bounded(instrument, lease, this.drain(instrument))
      .catch(async (error: unknown) => {
        this.logger.error({
          alert: 'engine_apply_failed',
          instrument,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        if (error instanceof FencedOutError) {
          // Протермінований lease локально не є відхиленим записом: PG його не бачив.
          if (lease?.active) this.ownership.fencedWrites++;
          if (lease) this.ownership.leases.drop(lease);
          this.logger.warn(`fenced out instrument=${instrument}`);
          return;
        }
        // COMMIT міг відбутися без підтвердження: наступна спроба відновить книгу з БД.
        try {
          await this.reload(instrument);
        } catch {
          /* Наступний poll повторить recovery після відновлення PostgreSQL. */
        }
      })
      .finally(() => {
        if (this.running.get(instrument) === task) this.running.delete(instrument);
      });
    this.running.set(instrument, task);
    return task;
  }

  private async drain(instrument: string): Promise<void> {
    const started = performance.now();
    // Завислий drain може прокинутися вже після нового lease цієї ж репліки.
    const lease = this.owned.get(instrument)?.lease;
    for (
      let count = 0;
      count < 100 && !this.stopped && performance.now() - started < DRAIN_BUDGET_MS;
      count++
    ) {
      const owned = this.owned.get(instrument);
      if (!owned || owned.lease !== lease) return;
      this.step(owned.lease);
      if (owned.halted) return;
      const [row]: (CommandRow & { next_seq: string })[] = await this.source.query(
        `SELECT c.*,i.next_seq FROM instruments i
        LEFT JOIN LATERAL (SELECT * FROM order_commands WHERE instrument=i.symbol AND seq>$2 ORDER BY seq LIMIT 1) c ON true
        WHERE i.symbol=$1`,
        [instrument, owned.seq],
      );
      if (this.owned.get(instrument) !== owned) return;
      if (!row.seq && BigInt(row.next_seq) === BigInt(owned.seq)) {
        this.gaps.delete(instrument);
        return;
      }
      if (!row.seq || BigInt(row.seq) !== BigInt(owned.seq) + 1n) {
        const since = this.gaps.get(instrument) ?? performance.now();
        this.gaps.set(instrument, since);
        if (performance.now() - since >= this.config.getOrThrow<number>('SEQ_GAP_ALERT_MS')) {
          await this.source.transaction(async (db) => {
            await lockEpoch(db, instrument, owned.epoch);
            this.ownership.leases.assert(owned.lease);
            await haltInstrument(db, instrument);
          });
          owned.halted = true;
          seqGaps.inc({ instrument });
          this.logger.error({
            alert: 'engine_seq_gap',
            instrument,
            seq: (BigInt(owned.seq) + 1n).toString(),
          });
        }
        return;
      }
      this.gaps.delete(instrument);
      const fields = { instrument, orderId: row.order_id, seq: row.seq, epoch: owned.epoch };
      const result = await traced('engine.apply', row.traceparent, fields, async () => {
        row.traceparent = activeTraceparent(row.traceparent ?? undefined) ?? null;
        const stop = commandSeconds.startTimer({ instrument });
        const applied = await this.source.transaction((db) => this.applyOne(db, owned, row));
        stop();
        if (!applied) return;
        commandsApplied.inc({ instrument });
        if (applied.outcome === 'rejected_internal') ordersRejected.inc({ reason: 'internal' });
        this.logger.log({ event: 'engine.command_applied', ...fields });
        for (const { tradeId } of applied.trades) {
          this.logger.log({ event: 'engine.trade_executed', ...fields, tradeId });
        }
        return applied;
      });
      if (!result) {
        owned.halted = true;
        return;
      }
      await this.chaos.reach('after_commit_before_memory', row.seq, result.trades.length);
      this.ownership.leases.assert(owned.lease);
      owned.book = result.book;
      owned.seq = row.seq;
      this.books.commit(instrument, result.book, row.seq);
    }
  }

  private async applyOne(
    db: EntityManager,
    owned: OwnedBook,
    row: CommandRow,
  ): Promise<WorkerResult | undefined> {
    const state = await lockEpoch(db, row.instrument, owned.epoch);
    this.ownership.leases.assert(owned.lease);
    if (state.status === 'halted' || state.legacy_verified !== true) return;
    if (state.last_applied_seq !== owned.seq) throw new Error('Committed book sequence changed');
    const target = await db.getRepository(Order).findOneByOrFail({ id: row.order_id });
    const command: Command =
      row.type === 'submit'
        ? {
            type: 'submit',
            instrument: row.instrument,
            seq: BigInt(row.seq),
            acceptedAt: row.accepted_at.toISOString(),
            order: bookOrder(target),
          }
        : {
            type: 'cancel',
            orderId: target.id,
            ...((target.status === 'filled' || target.status === 'cancelled') && {
              terminalStatus: target.status,
            }),
          };
    let result: WorkerResult;
    try {
      result = this.applier.apply(owned.book, command);
    } catch {
      result = toRejectedInternal(
        owned.book,
        bookOrder(target),
        target.status === 'filled' || target.status === 'cancelled',
      );
      this.logger.error({
        alert: 'engine_command_rejected',
        instrument: row.instrument,
        seq: row.seq,
        orderId: row.order_id,
      });
    }
    const delta: EngineEvent = {
      type: 'book.delta',
      payload: {
        instrument: row.instrument,
        seq: row.seq,
        changes: result.levelChanges.map((level) => ({
          side: level.side === 'buy' ? 'bid' : 'ask',
          price: formatPrice(level.price),
          quantity: level.quantity === 0n ? '0' : formatQuantity(level.quantity),
          orders: level.orders,
        })),
      },
    };
    const events: EngineEvent[] = [
      delta,
      ...(await this.writeOrders(db, owned.lease, target, result.orderChanges)),
      ...(await this.writeTrades(db, owned.lease, row, target, result.trades)),
    ];
    for (const closed of result.closed) {
      if (closed.releasedAmount <= 0n) continue;
      const { baseAsset, quoteAsset } = this.instrumentAssets(row.instrument);
      events.push({
        type: 'order.closed',
        payload: {
          orderId: closed.orderId,
          userId: target.ownerId,
          instrument: row.instrument,
          side: target.side,
          reason: closed.reason === 'user' ? 'cancelled' : closed.reason,
          releasedAsset: target.side === 'buy' ? quoteAsset : baseAsset,
          releasedAmount: closed.releasedAmount.toString(),
          seq: row.seq,
        },
      });
    }
    this.step(owned.lease);
    await insertOutboxEvents(db, row, events);
    const [, applied] = await db.query(
      `UPDATE order_commands SET applied_at=now(),result=$3 WHERE instrument=$1 AND seq=$2`,
      [
        row.instrument,
        row.seq,
        {
          status: result.outcome,
          tradeIds: result.trades.map(({ tradeId }) => tradeId),
          epoch: state.owner_epoch,
          instance: this.config.getOrThrow('INSTANCE_ID'),
        },
      ],
    );
    if (applied !== 1) throw new Error('Command journal row changed');
    const totals = counters(result.book);
    const updated = await db.query(
      `UPDATE instrument_state
      SET last_applied_seq=$2,resting_count=$3,resting_quantity=$4,
          resting_bid_count=$6,resting_ask_count=$7,resting_bid_lots=$8,resting_ask_lots=$9
      WHERE instrument=$1 AND last_applied_seq=$5 AND owner_epoch=$10 RETURNING instrument`,
      [
        row.instrument,
        row.seq,
        totals.count,
        totals.quantity,
        owned.seq,
        totals.bidCount,
        totals.askCount,
        totals.bidLots,
        totals.askLots,
        owned.epoch,
      ],
    );
    if (updated[1] !== 1) throw new FencedOutError();
    await db.query("SELECT pg_notify('order_applied',$1)", [`${row.order_id}:${row.seq}`]);
    await this.chaos.reach('after_writes_before_commit', row.seq, result.trades.length);
    await this.chaos.reach('stall_before_commit', row.seq, result.trades.length);
    this.ownership.leases.assert(owned.lease);
    return result;
  }

  private async writeOrders(
    db: EntityManager,
    lease: InstrumentLease,
    target: Order,
    changes: WorkerResult['orderChanges'],
  ): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for (const change of changes) {
      this.step(lease);
      const previous =
        change.id === target.id
          ? target
          : await db.getRepository(Order).findOneByOrFail({ id: change.id });
      const state = {
        status: change.status,
        remainingQuantity: formatQuantity(change.remaining),
        filledQuantity: formatQuantity(change.quantity - change.remaining),
        version: previous.version! + 1,
      };
      const updated = await db
        .getRepository(Order)
        .update(
          { id: change.id, version: previous.version },
          { ...state, cancelReason: change.cancelReason ?? null, updatedAt: new Date() },
        );
      if (updated.affected !== 1) throw new Error('Order version changed');
      events.push({
        type: 'order.updated',
        payload: {
          orderId: change.id,
          userId: previous.ownerId,
          instrument: target.instrument,
          ...state,
          ...(change.cancelReason && { cancelReason: change.cancelReason }),
        },
      });
    }
    return events;
  }

  private async writeTrades(
    db: EntityManager,
    lease: InstrumentLease,
    row: CommandRow,
    target: Order,
    trades: WorkerResult['trades'],
  ): Promise<EngineEvent[]> {
    if (trades.length === 0) return [];
    const { baseAsset, quoteAsset } = this.instrumentAssets(row.instrument);
    const events: EngineEvent[] = [];
    for (const [fillIndex, fill] of trades.entries()) {
      this.step(lease);
      const buy = await db.getRepository(Order).findOneByOrFail({ id: fill.buyOrderId });
      const sell = await db.getRepository(Order).findOneByOrFail({ id: fill.sellOrderId });
      const publicTrade: TradePublicV1 = {
        tradeId: fill.tradeId,
        instrument: row.instrument,
        seq: row.seq,
        price: formatPrice(fill.price),
        quantity: formatQuantity(fill.quantity),
        takerSide: target.side,
        executedAt: row.accepted_at.toISOString(),
      };
      const execution: TradeExecutedV1 = {
        ...publicTrade,
        fillIndex,
        baseAsset,
        quoteAsset,
        quoteAmount: (fill.price * fill.quantity).toString(),
        buyOrderId: buy.id,
        sellOrderId: sell.id,
        buyerUserId: buy.ownerId,
        sellerUserId: sell.ownerId,
        buyLimitPrice: buy.price,
      };
      await db.query(
        `INSERT INTO trades (trade_id,instrument,seq,fill_index,price,quantity,quote_amount,
        buyer_order_id,seller_order_id,buyer_user_id,seller_user_id,taker_side,executed_at,trace_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          execution.tradeId,
          execution.instrument,
          execution.seq,
          execution.fillIndex,
          execution.price,
          execution.quantity,
          execution.quoteAmount,
          execution.buyOrderId,
          execution.sellOrderId,
          execution.buyerUserId,
          execution.sellerUserId,
          execution.takerSide,
          row.accepted_at,
          row.traceparent?.split('-')[1] ?? null,
        ],
      );
      events.push(
        { type: 'trade.public', payload: publicTrade },
        { type: 'trade.executed', payload: execution },
      );
    }
    return events;
  }

  private instrumentAssets(instrument: string) {
    const entry = this.catalog.list().find(({ symbol }) => symbol === instrument);
    if (!entry) throw new Error('Instrument missing from the catalog');
    return entry;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.notifications.commandListeners.delete(this.wake);
    this.notifications.resumeListeners.delete(this.resume);
    await Promise.all(
      [...this.loading.values(), ...this.running.values()].map((task) =>
        task.catch(() => undefined),
      ),
    );
  }
}
