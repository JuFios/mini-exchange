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
import { OwnershipCoordinator } from '../ownership/ownership-coordinator';
import { InstrumentLease } from '../ownership/lease-manager';
import { FencedOutError, lockEpoch } from '../ownership/fencing';
import { ChaosHooks } from '../chaos/chaos-hooks';
import { PgNotifications } from './pg-notifications';

// Resume і shutdown чекають на поточний drain, тому один прохід обмежений часом.
// Решту backlog забере наступний poll або NOTIFY.
const DRAIN_BUDGET_MS = 1000;

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
    try {
      const owned = await this.ownership.recover(instrument, lease);
      this.owned.set(instrument, owned);
      if (owned.quarantined) this.books.quarantine(instrument);
      else this.books.commit(instrument, owned.book, owned.seq);
    } catch (error) {
      this.ownership.leases.drop(lease);
      throw error;
    }
  }

  private readonly resume = (request: { instrument: string; id: string }) => {
    const owned = this.owned.get(request.instrument);
    if (!owned || !this.ownership.leases.valid(owned.lease)) return;
    const previous = this.running.get(request.instrument);
    const task = (async () => {
      await this.notifications.ackResume(request.id).catch(() => undefined);
      await previous;
      const recovered = await this.ownership.recover(request.instrument, owned.lease, true);
      this.owned.set(request.instrument, recovered);
      if (recovered.quarantined) this.books.quarantine(request.instrument);
      else this.books.commit(request.instrument, recovered.book, recovered.seq);
      await this.notifications.answerResume(request.id, !recovered.halted);
    })()
      .catch((error: unknown) => {
        this.logger.error({
          alert: 'engine_resume_failed',
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
    const task = this.drain(instrument)
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
    for (
      let count = 0;
      count < 100 && !this.stopped && performance.now() - started < DRAIN_BUDGET_MS;
      count++
    ) {
      const owned = this.owned.get(instrument);
      if (!owned) return;
      this.ownership.leases.assert(owned.lease);
      if (owned.halted) return;
      const [row]: (CommandRow & { next_seq: string })[] = await this.source.query(
        `SELECT c.*,i.next_seq FROM instruments i
        LEFT JOIN LATERAL (SELECT * FROM order_commands WHERE instrument=i.symbol AND seq>$2 ORDER BY seq LIMIT 1) c ON true
        WHERE i.symbol=$1`,
        [instrument, owned.seq],
      );
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
            await db.query("UPDATE instrument_state SET status='halted' WHERE instrument=$1", [
              instrument,
            ]);
          });
          owned.halted = true;
          this.logger.error({
            alert: 'engine_seq_gap',
            instrument,
            seq: (BigInt(owned.seq) + 1n).toString(),
          });
        }
        return;
      }
      this.gaps.delete(instrument);
      const result = await this.source.transaction((db) => this.applyOne(db, owned, row));
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
    for (const change of result.orderChanges) {
      const previous =
        change.id === target.id
          ? target
          : await db.getRepository(Order).findOneByOrFail({ id: change.id });
      const updated = await db.getRepository(Order).update(
        { id: change.id, version: previous.version },
        {
          status: change.status as OrderStatus,
          remainingQuantity: formatQuantity(change.remaining),
          filledQuantity: formatQuantity(change.quantity - change.remaining),
          cancelReason: change.cancelReason ?? null,
          version: previous.version! + 1,
          updatedAt: new Date(),
        },
      );
      if (updated.affected !== 1) throw new Error('Order version changed');
    }
    for (const [index, fill] of result.trades.entries()) {
      const buy = await db.getRepository(Order).findOneByOrFail({ id: fill.buyOrderId });
      const sell = await db.getRepository(Order).findOneByOrFail({ id: fill.sellOrderId });
      await db.query(
        `INSERT INTO trades (trade_id,instrument,seq,fill_index,price,quantity,quote_amount,
        buyer_order_id,seller_order_id,buyer_user_id,seller_user_id,taker_side,executed_at,trace_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          fill.tradeId,
          row.instrument,
          row.seq,
          index,
          formatPrice(fill.price),
          formatQuantity(fill.quantity),
          (fill.price * fill.quantity).toString(),
          buy.id,
          sell.id,
          buy.ownerId,
          sell.ownerId,
          target.side,
          row.accepted_at,
          row.traceparent?.split('-')[1] ?? null,
        ],
      );
    }
    if (result.outcome === 'rejected_internal') {
      await this.rejectionEvents(db, row, target, result);
    }
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

  private async rejectionEvents(
    db: EntityManager,
    row: CommandRow,
    target: Order,
    result: WorkerResult,
  ): Promise<void> {
    const events: [string, string, object][] = [
      [
        `exchange:market:{${row.instrument}}`,
        'book.delta',
        {
          instrument: row.instrument,
          seq: row.seq,
          changes: result.levelChanges.map((level) => ({
            side: level.side === 'buy' ? 'bid' : 'ask',
            price: formatPrice(level.price),
            quantity: level.quantity === 0n ? '0' : formatQuantity(level.quantity),
            orders: level.orders,
          })),
        },
      ],
      ...result.closed.map((closed): [string, string, object] => [
        `exchange:settlement:{${row.instrument}}`,
        'order.closed',
        {
          orderId: target.id,
          userId: target.ownerId,
          instrument: row.instrument,
          side: target.side,
          reason: 'rejected',
          releasedAsset: this.catalog.list().find(({ symbol }) => symbol === row.instrument)![
            target.side === 'buy' ? 'quoteAsset' : 'baseAsset'
          ],
          releasedAmount: closed.releasedAmount.toString(),
          seq: row.seq,
        },
      ]),
    ];
    for (const [stream, type, payload] of events) {
      await db.query(
        `INSERT INTO outbox(event_id,stream,type,version,instrument,seq,payload,traceparent)
        VALUES ($1,$2,$3,1,$4,$5,$6,$7)`,
        [randomUUID(), stream, type, row.instrument, row.seq, payload, row.traceparent],
      );
    }
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
