import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { InstrumentCatalog } from './instrument-catalog';
import { OrderBookService } from './order-book.service';
import { DEFAULT_BOOK_DEPTH, MAX_BOOK_DEPTH } from './order-book.types';

@Controller()
export class MarketController {
  constructor(
    private readonly book: OrderBookService,
    private readonly instruments: InstrumentCatalog,
  ) {}

  @Get('instruments')
  list() {
    return this.instruments.list();
  }

  @Get('instruments/:instrument/book')
  depth(@Param('instrument') instrument: string, @Query('depth') depth: unknown) {
    return this.snapshot(instrument, depth);
  }

  @Get('orders/book')
  legacyDepth(@Query('instrument') instrument: unknown, @Query('depth') depth: unknown) {
    return this.snapshot(instrument, depth);
  }

  private snapshot(symbol: unknown, depth: unknown) {
    const instrument = this.instruments.require(symbol);
    let limit = DEFAULT_BOOK_DEPTH;
    if (depth !== undefined) {
      if (typeof depth !== 'string' || !/^[1-9][0-9]?$/.test(depth) || Number(depth) > MAX_BOOK_DEPTH) {
        throw new BadRequestException(`Глибина має бути цілим числом від 1 до ${MAX_BOOK_DEPTH}`);
      }
      limit = Number(depth);
    }
    return { instrument, ...this.book.depth(instrument, limit) };
  }
}
