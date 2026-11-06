import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { OrderBookService } from './order-book.service';

@Controller()
export class MarketController {
  constructor(private readonly book: OrderBookService) {}

  @Get('instruments/:instrument/book')
  depth(@Param('instrument') instrument: string, @Query('depth') depth?: string) {
    return this.snapshot(instrument, depth);
  }

  @Get('orders/book')
  legacyDepth(@Query('instrument') instrument: string, @Query('depth') depth?: string) {
    return this.snapshot(instrument, depth);
  }

  private snapshot(instrument: string, depth?: string) {
    const limit = depth === undefined ? 50 : Number(depth);
    if (depth !== undefined && (!/^[1-9][0-9]?$/.test(depth) || limit > 50)) {
      throw new BadRequestException('Глибина має бути цілим числом від 1 до 50');
    }
    return { instrument, ...this.book.depth(instrument, limit) };
  }
}
