import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsOptional, Matches } from 'class-validator';
import { DataSource } from 'typeorm';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { InternalTokenGuard } from '../security/internal-token.guard';

// Мітка виконання має точність до мілісекунди: так її бачить settlement.
const TIMESTAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const MAX_PAGE = 1000;

export class InternalTradesQuery {
  @Matches(new RegExp(`^${TIMESTAMP}$`))
  from: string;

  @Matches(new RegExp(`^${TIMESTAMP}$`))
  to: string;

  @IsOptional()
  instrument?: string;

  @IsOptional()
  @Matches(new RegExp(`^${TIMESTAMP},${UUID}$`))
  after?: string;

  @IsOptional()
  @Matches(/^(?:[1-9][0-9]{0,2}|1000)$/)
  limit?: string;
}

@Controller('internal/trades')
@UseGuards(InternalTokenGuard)
export class InternalTradesController {
  constructor(
    private readonly source: DataSource,
    private readonly instruments: InstrumentCatalog,
  ) {}

  /** Сторінка угод періоду [from, to) у порядку (executedAt, tradeId) для звірки з ledger. */
  @Get()
  async page(@Query() query: InternalTradesQuery) {
    const limit = Number(query.limit ?? MAX_PAGE);
    // Шаблон не відхиляє неіснуючі дати (місяць 13), які PostgreSQL відхилив би помилкою 500.
    for (const stamp of [query.from, query.to, query.after?.split(',')[0]])
      if (stamp !== undefined && Number.isNaN(Date.parse(stamp)))
        throw new BadRequestException('Некоректна дата');
    const params: unknown[] = [query.from, query.to];
    let filter = '';
    if (query.instrument) {
      params.push(this.instruments.require(query.instrument));
      filter += ` AND t.instrument = $${params.length}`;
    }
    if (query.after) {
      const [executedAt, tradeId] = query.after.split(',');
      params.push(executedAt, tradeId);
      filter += ` AND (t.executed_at, t.trade_id) > ($${params.length - 1}, $${params.length})`;
    }
    // Один snapshot на сторінку: угода, що з'явилася під час читання, не потрапляє на півдороги.
    const rows: { executedAt: Date; tradeId: string }[] = await this.source.transaction(
      'REPEATABLE READ',
      async (db) => {
        await db.query('SET TRANSACTION READ ONLY');
        return db.query(
          `SELECT t.trade_id AS "tradeId", t.instrument, t.executed_at AS "executedAt", t.price,
             t.quantity, t.buyer_order_id AS "buyOrderId", t.seller_order_id AS "sellOrderId",
             t.buyer_user_id AS "buyerUserId", t.seller_user_id AS "sellerUserId",
             o.price AS "buyLimitPrice", i.base_asset AS "baseAsset", i.quote_asset AS "quoteAsset"
           FROM trades t
             JOIN orders o ON o.id = t.buyer_order_id
             JOIN instruments i ON i.symbol = t.instrument
           WHERE t.executed_at >= $1 AND t.executed_at < $2${filter}
           ORDER BY t.executed_at, t.trade_id LIMIT ${limit}`,
          params,
        );
      },
    );
    const last = rows[rows.length - 1];
    return {
      trades: rows,
      next: rows.length === limit ? `${last.executedAt.toISOString()},${last.tradeId}` : null,
    };
  }
}
