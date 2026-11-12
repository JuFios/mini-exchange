import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { IntakeService } from '../intake/intake.service';
import { PgNotifications } from '../engine/pg-notifications';
import { Order } from './entities/order.entity';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { InstrumentCatalog } from './instrument-catalog';
import { ConcurrencyLimit } from '../database/concurrency-limit';

// Разом із межею читання книги лишає worker вільні з'єднання з 10 під потоком заявок.
const MAX_CONCURRENT_ORDERS = 5;
const MAX_WAITING_ORDERS = 500;
const MAX_ORDER_WAIT_MS = 5000;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly limit = new ConcurrencyLimit(
    MAX_CONCURRENT_ORDERS,
    MAX_WAITING_ORDERS,
    MAX_ORDER_WAIT_MS,
    'ORDERS_BUSY',
  );
  // Прийом ходить до settlement по HTTP. Його межа окрема, тож завислий settlement займає
  // лише її, а слоти PG лишаються скасуванням і читанням.
  private readonly submissions = new ConcurrencyLimit(
    MAX_CONCURRENT_ORDERS,
    MAX_WAITING_ORDERS,
    MAX_ORDER_WAIT_MS,
    'ORDERS_BUSY',
  );

  constructor(
    private readonly source: DataSource,
    private readonly intake: IntakeService,
    private readonly notifications: PgNotifications,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
  ) {}

  // Команда вже в журналі. Відмова тут збрехала б клієнту, а повтор без ключа створив би дубль.
  private async afterAcceptance<T, P>(
    orderId: string,
    read: () => Promise<T>,
    pending: () => P,
  ): Promise<T | P> {
    try {
      return await read();
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) throw error;
      this.logger.warn({ alert: 'order_read_after_accept_failed', orderId });
      return pending();
    }
  }

  async submitOrder(dto: SubmitOrderDto, ownerId: string, key?: string, traceparent?: string) {
    // NOTIFY міг прийти до встановлення waiter: applied_at закриває це вікно.
    const accepted = await this.submissions.run(() =>
      this.intake.submit(dto, ownerId, key, traceparent, (work) => this.limit.run(work)),
    );
    const wait = this.notifications.wait(
      accepted.orderId,
      accepted.seq,
      this.config.getOrThrow('ORDER_SYNC_WAIT_MS'),
    );
    try {
      return await this.afterAcceptance(
        accepted.orderId,
        async () => {
          if (!accepted.replay) {
            const [command] = await this.limit.run(() =>
              this.source.query(
                "SELECT applied_at FROM order_commands WHERE order_id=$1 AND type='submit'",
                [accepted.orderId],
              ),
            );
            if (!command.applied_at) await wait.ready;
          }
          const body = await this.limit.run(() =>
            this.source.transaction('REPEATABLE READ', async (db) => {
              await db.query('SET TRANSACTION READ ONLY');
              const order = await db
                .getRepository(Order)
                .findOneBy({ id: accepted.orderId, ownerId });
              if (!order) throw new NotFoundException('Заявку не знайдено');
              const trades = await db.query(
                `SELECT trade_id AS "tradeId",instrument,seq,price,quantity,
          buyer_order_id AS "buyOrderId",seller_order_id AS "sellOrderId",taker_side AS "takerSide",executed_at AS "executedAt"
          FROM trades WHERE buyer_order_id=$1 OR seller_order_id=$1 ORDER BY seq,fill_index`,
                [order.id],
              );
              return { order, trades };
            }),
          );
          return {
            status: accepted.replay ? 200 : body.order.status === 'pending' ? 202 : 201,
            body,
          };
        },
        () => ({
          status: 202,
          body: {
            order: {
              id: accepted.orderId,
              ownerId,
              instrument: dto.instrument,
              side: dto.side,
              status: 'pending' as const,
            },
            trades: [],
          },
        }),
      );
    } finally {
      wait.cancel();
    }
  }

  async cancelOrder(
    orderId: string,
    userId: string,
    instrumentHint?: string,
    traceparent?: string,
  ) {
    const order = await this.limit.run(() => this.getOwn(orderId, userId));
    if (instrumentHint !== undefined && instrumentHint !== order.instrument) {
      throw new BadRequestException('Інструмент не збігається з інструментом заявки');
    }
    await this.limit.run(() => this.intake.assertActive(this.source.manager, order.instrument));
    if (order.status === 'filled' || order.status === 'cancelled') this.terminal(order);
    const accepted = await this.limit.run(() => this.intake.cancel(order, traceparent));
    const wait = this.notifications.wait(
      order.id,
      accepted.seq,
      this.config.getOrThrow('ORDER_SYNC_WAIT_MS'),
    );
    const pending = { status: 202, body: { orderId: order.id, cancelSeq: accepted.seq } };
    try {
      return await this.afterAcceptance(
        order.id,
        async () => {
          const read = async () => {
            const [command] = await this.limit.run(() =>
              this.source.query(
                "SELECT applied_at,result FROM order_commands WHERE order_id=$1 AND type='cancel'",
                [order.id],
              ),
            );
            return command;
          };
          let command = await read();
          if (!command.applied_at) {
            await wait.ready;
            command = await read();
          }
          if (!command.applied_at) return pending;
          const final = await this.limit.run(() => this.getOwn(order.id, userId));
          if (
            command.result.status === 'already_filled' ||
            command.result.status === 'already_cancelled'
          )
            this.terminal(final);
          return { status: 200, body: { order: final } };
        },
        () => pending,
      );
    } finally {
      wait.cancel();
    }
  }

  private terminal(order: Order): never {
    throw new ConflictException({
      code: order.status === 'filled' ? 'ORDER_ALREADY_FILLED' : 'ORDER_ALREADY_CANCELLED',
      message: 'Заявку вже закрито',
      order,
    });
  }

  async getOwn(id: string, ownerId: string): Promise<Order> {
    const order = await this.source.getRepository(Order).findOneBy({ id, ownerId });
    if (!order) throw new NotFoundException('Заявку не знайдено');
    return order;
  }

  async listOwn(ownerId: string, query: ListOrdersQueryDto = {}): Promise<Order[]> {
    const builder = this.source
      .getRepository(Order)
      .createQueryBuilder('o')
      .where('o.owner_id=:ownerId', { ownerId });
    if (query.instrument !== undefined) {
      this.catalog.require(query.instrument);
      builder.andWhere('o.instrument=:instrument', { instrument: query.instrument });
    }
    if (query.status === 'active')
      builder.andWhere("o.status IN ('pending','open','partially_filled')");
    if (query.status === 'filled') builder.andWhere("o.status='filled'");
    if (query.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          createdAt: string;
          id: string;
        };
        if (!isUUID(decoded.id) || new Date(decoded.createdAt).toISOString() !== decoded.createdAt)
          throw new Error();
        // Курсор несе мілісекунди, а імпортовані заявки starter можуть мати мікросекунди. Без
        // точного часу рядка курсора заявка з тієї самої мілісекунди, але старша, випала б між
        // сторінками. Час із курсора лишається межею, якщо рядок не знайдено або він не збігається.
        builder.andWhere(
          `(o.created_at,o.id)<(COALESCE((SELECT c.created_at FROM orders c
            WHERE c.id=:id AND c.owner_id=:ownerId
              AND date_trunc('milliseconds',c.created_at)=:createdAt),:createdAt),:id)`,
          { createdAt: decoded.createdAt, id: decoded.id },
        );
      } catch {
        throw new BadRequestException('Некоректний курсор');
      }
    }
    return builder
      .orderBy('o.created_at', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .take(Number(query.limit ?? 50))
      .getMany();
  }
}
