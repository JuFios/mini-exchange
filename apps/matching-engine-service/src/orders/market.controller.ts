import { DataSource } from 'typeorm';
import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { InstrumentCatalog } from './instrument-catalog';
import { OrderBookService } from './order-book.service';
import { DEFAULT_BOOK_DEPTH, MAX_BOOK_DEPTH } from './order-book.types';

@Controller()
export class MarketController {
  constructor(
    private readonly book: OrderBookService,
    private readonly instruments: InstrumentCatalog,
    private readonly source: DataSource,
  ) {}

  @Get('instruments')
  list() {
    return this.instruments.list();
  }

  @Get('instruments/:instrument/book')
  depth(@Param('instrument') instrument: string, @Query('depth') depth: unknown) {
    return this.snapshot(instrument, depth);
  }

  @Get('instruments/:instrument/trades')
  async trades(@Param('instrument') symbol: string, @Query('limit') value: unknown) {
    const instrument = this.instruments.require(symbol);
    if (
      value !== undefined &&
      (typeof value !== 'string' || !/^(?:[1-9][0-9]?|100)$/.test(value))
    ) {
      throw new BadRequestException('Ліміт має бути від 1 до 100');
    }
    return this.source.query(
      `SELECT trade_id AS "tradeId",seq,price,quantity,taker_side AS "takerSide",executed_at AS "executedAt"
      FROM trades WHERE instrument=$1 ORDER BY seq DESC,fill_index DESC LIMIT $2`,
      [instrument, Number(value ?? 50)],
    );
  }

  @Get('orders/book')
  legacyDepth(@Query('instrument') instrument: unknown, @Query('depth') depth: unknown) {
    return this.snapshot(instrument, depth);
  }

  private snapshot(symbol: unknown, depth: unknown) {
    const instrument = this.instruments.require(symbol);
    let limit = DEFAULT_BOOK_DEPTH;
    if (depth !== undefined) {
      if (
        typeof depth !== 'string' ||
        !/^[1-9][0-9]?$/.test(depth) ||
        Number(depth) > MAX_BOOK_DEPTH
      ) {
        throw new BadRequestException(`Глибина має бути цілим числом від 1 до ${MAX_BOOK_DEPTH}`);
      }
      limit = Number(depth);
    }
    return {
      instrument,
      seq: this.book.sequence(instrument),
      ...this.book.depth(instrument, limit),
    };
  }
}
