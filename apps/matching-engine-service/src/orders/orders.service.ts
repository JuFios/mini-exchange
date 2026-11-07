import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { IntakeService } from '../intake/intake.service';
import { PgNotifications } from '../engine/pg-notifications';
import { Order } from './entities/order.entity';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { InstrumentCatalog } from './instrument-catalog';

@Injectable()
export class OrdersService {
  constructor(
    private readonly source: DataSource,
    private readonly intake: IntakeService,
    private readonly notifications: PgNotifications,
    private readonly config: ConfigService,
    private readonly catalog: InstrumentCatalog,
  ) {}

  async submitOrder(dto: SubmitOrderDto, ownerId: string, key?: string, traceparent?: string) {
    // NOTIFY міг прийти до встановлення waiter: applied_at закриває це вікно.
    const accepted = await this.intake.submit(dto, ownerId, key, traceparent);
    const wait = this.notifications.wait(accepted.orderId, accepted.seq, this.config.getOrThrow('ORDER_SYNC_WAIT_MS'));
    try {
      if (!accepted.replay) {
        const [command] = await this.source.query("SELECT applied_at FROM order_commands WHERE order_id=$1 AND type='submit'", [accepted.orderId]);
        if (!command.applied_at) await wait.ready;
      }
      const body = await this.source.transaction('REPEATABLE READ', async (db) => {
        await db.query('SET TRANSACTION READ ONLY');
        const order = await db.getRepository(Order).findOneBy({ id: accepted.orderId, ownerId });
        if (!order) throw new NotFoundException('Заявку не знайдено');
        const trades = await db.query(`SELECT trade_id AS "tradeId",instrument,seq,price,quantity,
          buyer_order_id AS "buyOrderId",seller_order_id AS "sellOrderId",taker_side AS "takerSide",executed_at AS "executedAt"
          FROM trades WHERE buyer_order_id=$1 OR seller_order_id=$1 ORDER BY seq,fill_index`, [order.id]);
        return { order, trades };
      });
      return { status: accepted.replay ? 200 : body.order.status === 'pending' ? 202 : 201, body };
    } finally { wait.cancel(); }
  }

  async cancelOrder(orderId: string, userId: string, instrumentHint?: string, traceparent?: string) {
    const order = await this.getOwn(orderId, userId);
    if (instrumentHint !== undefined && instrumentHint !== order.instrument) {
      throw new BadRequestException('Інструмент не збігається з інструментом заявки');
    }
    await this.intake.assertActive(this.source.manager, order.instrument);
    if (order.status === 'filled' || order.status === 'cancelled') this.terminal(order);
    const accepted = await this.intake.cancel(order, traceparent);
    const wait = this.notifications.wait(order.id, accepted.seq, this.config.getOrThrow('ORDER_SYNC_WAIT_MS'));
    try {
      const read = async () => {
        const [command] = await this.source.query("SELECT applied_at,result FROM order_commands WHERE order_id=$1 AND type='cancel'", [order.id]);
        return command;
      };
      let command = await read();
      if (!command.applied_at) { await wait.ready; command = await read(); }
      if (!command.applied_at) return { status: 202, body: { orderId: order.id, cancelSeq: accepted.seq } };
      const final = await this.getOwn(order.id, userId);
      if (command.result.status === 'already_filled' || command.result.status === 'already_cancelled') this.terminal(final);
      return { status: 200, body: { order: final } };
    } finally { wait.cancel(); }
  }

  private terminal(order: Order): never {
    throw new ConflictException({
      code: order.status === 'filled' ? 'ORDER_ALREADY_FILLED' : 'ORDER_ALREADY_CANCELLED',
      message: 'Заявку вже закрито', order,
    });
  }

  async getOwn(id: string, ownerId: string): Promise<Order> {
    const order = await this.source.getRepository(Order).findOneBy({ id, ownerId });
    if (!order) throw new NotFoundException('Заявку не знайдено');
    return order;
  }

  async listOwn(ownerId: string, query: ListOrdersQueryDto = {}): Promise<Order[]> {
    const builder = this.source.getRepository(Order).createQueryBuilder('o').where('o.owner_id=:ownerId', { ownerId });
    if (query.instrument !== undefined) {
      this.catalog.require(query.instrument);
      builder.andWhere('o.instrument=:instrument', { instrument: query.instrument });
    }
    if (query.status === 'active') builder.andWhere("o.status IN ('pending','open','partially_filled')");
    if (query.status === 'filled') builder.andWhere("o.status='filled'");
    if (query.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { createdAt: string; id: string };
        if (!isUUID(decoded.id) || new Date(decoded.createdAt).toISOString() !== decoded.createdAt) throw new Error();
        builder.andWhere('(o.created_at,o.id)<(:createdAt,:id)', decoded);
      } catch { throw new BadRequestException('Некоректний курсор'); }
    }
    return builder.orderBy('o.created_at', 'DESC').addOrderBy('o.id', 'DESC').take(Number(query.limit ?? 50)).getMany();
  }
}
