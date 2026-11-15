import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, IsUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { InternalTokenGuard } from '../security/internal-token.guard';

export const MAX_TERMINAL_LOOKUP = 1000;
export const LIVE_PAGE_SIZE = 1000;
// Частковий індекс `orders_live_id_idx` дає сторінку за `id` без проходу термінальної історії.
export const LIVE_ORDERS_SQL = `SELECT o.id AS "orderId", o.owner_id AS "userId", o.instrument,
    o.created_at AS "createdAt"
  FROM orders o JOIN order_requests r ON r.order_id = o.id AND r.reserved
  WHERE o.status IN ('open','partially_filled') AND o.id > $1
    AND ($2::text IS NULL OR o.instrument = $2)
  ORDER BY o.id LIMIT ${LIVE_PAGE_SIZE}`;

export class TerminalOrdersBody {
  @IsArray()
  @ArrayMaxSize(MAX_TERMINAL_LOOKUP)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderIds: string[];
}

export class LiveOrdersBody {
  @IsUUID('all')
  after: string;

  @IsOptional()
  @IsString()
  instrument?: string;
}

@Controller('internal/orders')
@UseGuards(InternalTokenGuard)
export class InternalOrdersController {
  constructor(
    private readonly source: DataSource,
    private readonly instruments: InstrumentCatalog,
  ) {}

  /**
   * Із переданих заявок повертає термінальні (`filled`, `cancelled`) і час переходу.
   * Settlement питає про активні резерви, а не про всі заявки: їх мало, термінальних багато.
   * POST, бо 1000 UUID не вміщаються в рядок запиту; стан маршрут не змінює.
   */
  @Post('terminal')
  @HttpCode(200)
  async terminal(@Body() { orderIds }: TerminalOrdersBody) {
    const orders = await this.source.query(
      `SELECT id AS "orderId", instrument, status, updated_at AS "closedAt"
       FROM orders WHERE id = ANY($1::uuid[]) AND status IN ('filled','cancelled')
       ORDER BY id`,
      [orderIds],
    );
    return { orders };
  }

  /**
   * Сторінка книги (`open`, `partially_filled`), прийнятої з резервом, у порядку `id` після
   * `after`. Звірка settlement шукає серед них заявки без активного резерву: потік не
   * підписаний, і підроблений `order.closed` міг звільнити кошти заявки, що лишається в книзі.
   */
  @Post('live')
  @HttpCode(200)
  async live(@Body() { after, instrument }: LiveOrdersBody) {
    const orders = await this.source.query(LIVE_ORDERS_SQL, [
      after,
      instrument === undefined ? null : this.instruments.require(instrument),
    ]);
    return { orders };
  }
}
