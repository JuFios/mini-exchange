import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
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

@Injectable()
export class IntakeService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;

  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
    private readonly reservations: ReservationClient,
  ) {
    this.redis = new Redis({
      host: config.getOrThrow('REDIS_HOST'),
      port: config.getOrThrow('REDIS_PORT'),
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      commandTimeout: 1000,
      retryStrategy: () => 200,
    });
    this.redis.on('error', () => undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect().catch(() => undefined);
  }
  onModuleDestroy(): void {
    this.redis.disconnect();
  }

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

  async submit(
    dto: SubmitOrderDto,
    userId: string,
    key?: string,
    traceparent?: string,
  ): Promise<Acceptance> {
    const payload = this.normalize(dto);
    if (key !== undefined && /^[A-Za-z0-9_-]{1,64}$/.exec(key)?.[0] !== key) {
      throw new BadRequestException('Некоректний Idempotency-Key');
    }
    const idempotencyKey = key ?? randomUUID();
    const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (key !== undefined) {
      const [previous]: RequestRow[] = await this.source.query(
        'SELECT * FROM order_requests WHERE user_id=$1 AND idempotency_key=$2',
        [userId, key],
      );
      if (previous) {
        if (previous.request_hash !== requestHash) {
          throw new ConflictException({
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'Ключ уже використано з іншими даними',
          });
        }
        const completed = await this.existing(previous);
        if (completed) return completed;
      }
    }
    try {
      await this.redis.ping();
    } catch {
      throw new ServiceUnavailableException('Сервіс прийому заявок недоступний');
    }
    await this.assertActive(this.source.manager, dto.instrument);
    const [row]: RequestRow[] = await this.source.transaction(async (db) => {
      await db.query(
        `INSERT INTO order_requests (user_id, idempotency_key, request_hash, order_id, status)
        VALUES ($1,$2,$3,$4,'reserving') ON CONFLICT (user_id,idempotency_key) DO NOTHING`,
        [userId, idempotencyKey, requestHash, randomUUID()],
      );
      return db.query('SELECT * FROM order_requests WHERE user_id=$1 AND idempotency_key=$2', [
        userId,
        idempotencyKey,
      ]);
    });
    if (row.request_hash !== requestHash) {
      throw new ConflictException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Ключ уже використано з іншими даними',
      });
    }
    const existing = await this.existing(row);
    if (existing) return existing;
    const instrument = this.catalog.list().find(({ symbol }) => symbol === dto.instrument)!;
    const accepted = await this.reservations.reserve({
      reservationId: row.order_id,
      userId,
      instrument: dto.instrument,
      limitPrice: payload.price,
      asset: dto.side === 'buy' ? instrument.quoteAsset : instrument.baseAsset,
      amount: (dto.side === 'buy'
        ? parsePrice(payload.price) * parseQuantity(payload.quantity)
        : parseQuantity(payload.quantity)
      ).toString(),
    });
    const result = await this.source.transaction(async (db) => {
      await db.query("SET LOCAL lock_timeout='3s'");
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
      if (accepted === 'rejected') return null;
      const command = await this.sequence(
        db,
        dto.instrument,
        'submit',
        row.order_id,
        userId,
        payload,
        traceparent,
      );
      await this.assertActive(db, dto.instrument);
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
    if (row.status !== 'reserving')
      throw new ConflictException({
        code: 'REQUEST_EXPIRED',
        message: 'Час прийому заявки вичерпано',
      });
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
    const [command] = await db.query(
      `WITH s AS (
      UPDATE instruments SET next_seq=next_seq+1 WHERE symbol=$1 RETURNING next_seq
    ) INSERT INTO order_commands (instrument,seq,type,order_id,user_id,payload,traceparent)
      SELECT $1,s.next_seq,$2,$3,$4,$5,$6 FROM s RETURNING seq,accepted_at`,
      [instrument, type, orderId, userId, payload, traceparent ?? null],
    );
    await db.query("SELECT pg_notify('engine_commands',$1)", [instrument]);
    return command as { seq: string; accepted_at: Date };
  }
}
