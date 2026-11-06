import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ORDER_AMOUNT_LIMITS } from '../matching/decimal';

@Injectable()
export class InstrumentCatalog {
  private readonly symbols: readonly string[];

  constructor(config: ConfigService) {
    this.symbols = config.getOrThrow<string[]>('INSTRUMENTS');
  }

  has(symbol: unknown): symbol is string {
    return typeof symbol === 'string' && this.symbols.includes(symbol);
  }

  require(symbol: unknown): string {
    if (!this.has(symbol)) throw new BadRequestException('Невідомий інструмент');
    return symbol;
  }

  list() {
    return this.symbols.map((symbol) => ({
      symbol,
      baseAsset: symbol,
      quoteAsset: 'USD',
      ...ORDER_AMOUNT_LIMITS,
    }));
  }
}
