import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { Order } from '../orders/entities/order.entity';
import { SubmitOrderDto } from '../orders/dto/submit-order.dto';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import {
  DecimalError,
  formatPrice,
  formatQuantity,
  parsePrice,
  parseQuantity,
} from '../matching/decimal';
import { ReservationClient } from './reservation.client';
import { RateLimits } from '../security/rate-limits';

// Скільки нові заявки отримують 503 без `seq` після того, як settlement не відповів на резерв.
// Кожен збій поспіль подвоює паузу: за тривалої відмови черга інструмента чекає на дедлайн
// резерву не частіше ніж раз на 30 с.
const RESERVATION_BACKOFF_MS = 1000;
const RESERVATION_BACKOFF_MAX_MS = 30_000;
const reservationUnavailable = () =>
  new ServiceUnavailableException('Сервіс резервування недоступний');

const expired = () =>
  new ConflictException({ code: 'REQUEST_EXPIRED', message: 'Час прийому заявки вичерпано' });

interface SequencedSubmit {
  seq: string;
  accepted_at: Date;
  left_ms: number;
}
interface RequestRow {
  order_id: string;
  request_hash: string;
  status: string;
  response: unknown;
}
export interface Acceptance {
  orderId: string;
  seq: string;
  replay: boolean;
}
/** Виконує крок, що займає з'єднання PG: викликач обмежує такі кроки своїм лімітом. */
export type PgStep = <T>(work: () => Promise<T>) => Promise<T>;

@Injectable()
export class IntakeService {
  private reservationsDownUntil = 0;
  private reservationFailures = 0;

  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
    private readonly reservations: ReservationClient,
    private readonly limits: RateLimits,
  ) {}

  normalize(dto: SubmitOrderDto): SubmitOrderDto & { price: string; quantity: string } {
    this.catalog.require(dto.instrument);
    const amount = (read: () => string, message: string) => {
      try {
        return read();
      } catch (error) {
        if (error instanceof DecimalError) throw new BadRequestException([message]);
        throw error;
      }
    };
    return {
      instrument: dto.instrument,
      side: dto.side,
      price: amount(() => formatPrice(parsePrice(dto.price)), 'Некоректна ціна'),
      quantity: amount(() => formatQuantity(parseQuantity(dto.quantity)), 'Некоректна кількість'),
    };
  }

  async assertActive(db: Pick<EntityManager, 'query'>, instrument: string): Promise<void> {
    const [state] = await db.query(
      'SELECT status,legacy_verified FROM instrument_state WHERE instrument=$1',
      [instrument],
    );
    if (state?.status !== 'active' || state.legacy_verified !== true) {
      throw new ServiceUnavailableException({
        code: 'INSTRUMENT_HALTED',
        message: 'Інструмент зупинено',
      });
    }
  }

  private async assertReservationMode(db: EntityManager): Promise<void> {
    if (this.config.getOrThrow<boolean>('RESERVATIONS_ENABLED')) return;
    // SHARE тримається до commit: ввімкнення резервів не може випередити цю транзакцію.
    const [settings] = await db.query(
      'SELECT reservations_required FROM engine_settings WHERE id=true FOR SHARE',
    );
    if (!settings || settings.reservations_required) {
      throw new ServiceUnavailableException('Резервування обов’язкове для цієї бази даних');
    }
  }

  async submit(
    dto: SubmitOrderDto,
    userId: string,
    key?: string,
    traceparent?: string,
    pg: PgStep = (work) => work(),
    reserving: PgStep = (work) => work(),
  ): Promise<Acceptance> {
    const payload = this.normalize(dto);
    if (key !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
      throw new BadRequestException('Некоректний Idempotency-Key');
    }
    const idempotencyKey = key ?? randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const reused = () =>
      new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Ключ уже використано з іншими даними',
      });
    if (key !== undefined) {
      const completed = await pg(async () => {
        const [previous]: RequestRow[] = await this.source.query(
          'SELECT * FROM order_requests WHERE user_id=$1 AND idempotency_key=$2',
          [userId, key],
        );
        if (!previous) return undefined;
        if (previous.request_hash !== requestHash) throw reused();
        return this.existing(previous);
      });
      if (completed) return completed;
    }
    await this.limits.order(userId);
    // Поки settlement не відповідає, нові заявки не отримують `seq`: кожна така заявка тримала б
    // чергу інструмента до дедлайну резерву.
    if (performance.now() < this.reservationsDownUntil) throw reservationUnavailable();
    // Момент надходження — видача `seq`, до будь-якого виклику settlement. Повільний резерв однієї
    // заявки не дає пізнішій обігнати її.
    const claimed = await pg(async () => {
      await this.assertActive(this.source.manager, dto.instrument);
      return this.source.transaction(async (db) => {
        // До першого блокування: старт репліки тримає рядок режиму до 60 с, і без межі заявка
        // чекала б до statement_timeout.
        await db.query("SET LOCAL lock_timeout='3s'");
        await this.assertReservationMode(db);
        const inserted = await db.query(
          `INSERT INTO order_requests (user_id, idempotency_key, request_hash, order_id, status)
        VALUES ($1,$2,$3,$4,'reserving') ON CONFLICT (user_id,idempotency_key) DO NOTHING
        RETURNING order_id`,
          [userId, idempotencyKey, requestHash, randomUUID()],
        );
        if (inserted.length) {
          await this.sequence(
            db,
            dto.instrument,
            'submit',
            inserted[0].order_id,
            userId,
            payload,
            traceparent,
          );
          await this.assertActive(db, dto.instrument);
        }
        const [row]: RequestRow[] = await db.query(
          'SELECT * FROM order_requests WHERE user_id=$1 AND idempotency_key=$2',
          [userId, idempotencyKey],
        );
        if (row.status !== 'reserving') return { row, command: undefined };
        const [command]: (SequencedSubmit | undefined)[] = await db.query(
          `SELECT seq,accepted_at,
            ($2::int - extract(epoch FROM clock_timestamp() - accepted_at) * 1000)::int AS left_ms
          FROM order_commands WHERE order_id=$1 AND type='submit'`,
          [row.order_id, this.config.getOrThrow<number>('RESERVATION_WAIT_MS')],
        );
        return { row, command };
      });
    });
    const { row, command } = claimed;
    if (row.request_hash !== requestHash) throw reused();
    const done = await pg(() => this.existing(row));
    if (done) return done;
    // Запит попередньої версії, що чекав на резерв без `seq`: момент його надходження втрачено,
    // а резерв звільнить sweeper.
    if (!command) throw expired();
    const instrument = this.catalog.list().find(({ symbol }) => symbol === dto.instrument)!;
    // Worker чекає на резерв не довше `RESERVATION_WAIT_MS` від видачі `seq`. Пізніший результат
    // уже не застосується, тож запит до settlement обриваємо разом із цим дедлайном.
    const deadline = AbortSignal.timeout(Math.max(command.left_ms, 0));
    let accepted: 'accepted' | 'rejected';
    try {
      // Слот PG на час HTTP до settlement не тримаємо: повільний settlement зупиняв би скасування.
      accepted = await reserving(() => {
        deadline.throwIfAborted();
        return this.reservations.reserve(
          {
            reservationId: row.order_id,
            userId,
            instrument: dto.instrument,
            limitPrice: payload.price,
            asset: dto.side === 'buy' ? instrument.quoteAsset : instrument.baseAsset,
            amount: (dto.side === 'buy'
              ? parsePrice(payload.price) * parseQuantity(payload.quantity)
              : parseQuantity(payload.quantity)
            ).toString(),
          },
          deadline,
        );
      });
    } catch (error) {
      // Команда вже в журналі. Відмова звільняє її місце в черзі одразу, а не за дедлайном;
      // якщо PG недоступний, це зробить worker за дедлайном.
      await pg(() => this.abandon(dto.instrument, row.order_id)).catch(() => undefined);
      // Відповідь settlement (409, 500) і зайнятий слот репліки (`ORDERS_BUSY`) не означають, що
      // settlement недоступний. Решта — мережа, 5xx чи дедлайн.
      const answered =
        error instanceof HttpException &&
        (error.getStatus() !== 503 ||
          (error.getResponse() as { code?: string }).code === 'ORDERS_BUSY');
      if (answered) throw error;
      this.noteReservationOutage();
      throw reservationUnavailable();
    }
    // Відповідь після дедлайну вже не застосується: settlement надто повільний для черги.
    if (deadline.aborted) this.noteReservationOutage();
    else {
      this.reservationFailures = 0;
      this.reservationsDownUntil = 0;
    }
    return pg(async () => {
      const result = await this.source.transaction(async (db) => {
        await db.query("SET LOCAL lock_timeout='3s'");
        await this.assertReservationMode(db);
        const [rows] = await db.query(
          `UPDATE order_requests SET status=$3, updated_at=now(), response=$4, reserved=$5
        WHERE user_id=$1 AND idempotency_key=$2 AND status='reserving' RETURNING order_id`,
          [
            userId,
            idempotencyKey,
            accepted === 'accepted' ? 'accepted' : 'rejected',
            accepted === 'accepted'
              ? null
              : new UnprocessableEntityException('Недостатньо коштів').getResponse(),
            accepted === 'accepted' && this.config.getOrThrow('RESERVATIONS_ENABLED'),
          ],
        );
        if (!rows.length) return undefined;
        // Worker чекає на цю команду: сигнал будить його без очікування poll.
        await db.query("SELECT pg_notify('engine_commands',$1)", [dto.instrument]);
        if (accepted === 'rejected') return null;
        await db.getRepository(Order).insert({
          id: row.order_id,
          ownerId: userId,
          ...payload,
          remainingQuantity: payload.quantity,
          filledQuantity: '0.00000000',
          prioritySeq: command.seq,
          version: 0,
          status: 'pending',
          createdAt: command.accepted_at,
        });
        return { orderId: row.order_id, seq: command.seq, replay: false };
      });
      if (result === null) throw new UnprocessableEntityException('Недостатньо коштів');
      if (result) return result;
      const [latest] = await this.source.query(
        'SELECT * FROM order_requests WHERE user_id=$1 AND idempotency_key=$2',
        [userId, idempotencyKey],
      );
      return (await this.existing(latest))!;
    });
  }

  // Одна відмова settlement зачіпає всі заявки, що чекали на нього одночасно: пауза росте лише
  // від збою, що стався вже після попередньої паузи.
  private noteReservationOutage(): void {
    const now = performance.now();
    if (now < this.reservationsDownUntil) return;
    this.reservationFailures++;
    this.reservationsDownUntil =
      now +
      Math.min(
        RESERVATION_BACKOFF_MS * 2 ** Math.min(this.reservationFailures - 1, 10),
        RESERVATION_BACKOFF_MAX_MS,
      );
  }

  /** Знімає заявку з очікування резерву; release, якщо резерв усе ж створено, виконає sweeper. */
  private async abandon(instrument: string, orderId: string): Promise<void> {
    await this.source.transaction(async (db) => {
      const released = await db.query(
        `UPDATE order_requests SET status='releasing', updated_at=clock_timestamp(),
          release_due_at=NULL WHERE order_id=$1 AND status='reserving' RETURNING order_id`,
        [orderId],
      );
      if (released.length) await db.query("SELECT pg_notify('engine_commands',$1)", [instrument]);
    });
  }

  private async existing(row: RequestRow): Promise<Acceptance | undefined> {
    if (row.status === 'accepted') {
      const [command] = await this.source.query(
        "SELECT seq FROM order_commands WHERE order_id=$1 AND type='submit'",
        [row.order_id],
      );
      if (!command) throw new ServiceUnavailableException('Журнал заявки тимчасово недоступний');
      return { orderId: row.order_id, seq: command.seq, replay: true };
    }
    if (row.status === 'rejected') throw new UnprocessableEntityException(row.response as object);
    if (row.status !== 'reserving') throw expired();
  }

  async cancel(order: Order, traceparent?: string): Promise<Acceptance> {
    const lookup = () =>
      this.source.query("SELECT seq FROM order_commands WHERE order_id=$1 AND type='cancel'", [
        order.id,
      ]);
    const [existing] = await lookup();
    if (existing) return { orderId: order.id, seq: existing.seq, replay: true };
    try {
      return await this.source.transaction(async (db) => {
        await db.query("SET LOCAL lock_timeout='3s'");
        const command = await this.sequence(
          db,
          order.instrument,
          'cancel',
          order.id,
          order.ownerId,
          {},
          traceparent,
        );
        await this.assertActive(db, order.instrument);
        return { orderId: order.id, seq: command.seq, replay: false };
      });
    } catch (error) {
      if ((error as { driverError?: { code: string } }).driverError?.code !== '23505') throw error;
      const [command] = await lookup();
      if (!command) throw error;
      return { orderId: order.id, seq: command.seq, replay: true };
    }
  }

  // Рядок лічильника серіалізує intake з halt. Блокування стану заважало б worker: нові
  // FOR SHARE обганяють його FOR UPDATE, і під потоком заявок застосування стоїть.
  private async sequence(
    db: EntityManager,
    instrument: string,
    type: string,
    orderId: string,
    userId: string,
    payload: object,
    traceparent?: string,
  ) {
    // Час береться після блокування лічильника, а не на початку транзакції (`now()`): інакше
    // заявка, що чекала на seq, мала б раніший час за попередню, а її угода — раніший за maker.
    const [command] = await db.query(
      `WITH s AS (
      UPDATE instruments SET next_seq=next_seq+1 WHERE symbol=$1 RETURNING next_seq
    ) INSERT INTO order_commands (instrument,seq,type,order_id,user_id,payload,traceparent,accepted_at)
      SELECT $1,s.next_seq,$2,$3,$4,$5,$6,clock_timestamp() FROM s RETURNING seq,accepted_at`,
      [instrument, type, orderId, userId, payload, traceparent ?? null],
    );
    await db.query("SELECT pg_notify('engine_commands',$1)", [instrument]);
    return command as { seq: string; accepted_at: Date };
  }
}
