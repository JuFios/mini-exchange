import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Instrument } from './entities/instrument.entity';

@Injectable()
export class InstrumentCatalog implements OnModuleInit {
  private instruments: Instrument[] = [];

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Instrument) private readonly repository: Repository<Instrument>,
  ) {}

  async onModuleInit(): Promise<void> {
    const configured = this.config.getOrThrow<string[]>('INSTRUMENTS');
    const instruments = await this.repository.find({ order: { symbol: 'ASC' } });
    if (configured.length !== instruments.length || instruments.some(({ symbol }) => !configured.includes(symbol))) {
      throw new Error('INSTRUMENTS must match the symbols in the instruments table');
    }
    this.instruments = instruments;
  }

  has(symbol: unknown): symbol is string {
    return typeof symbol === 'string' && this.instruments.some((instrument) => instrument.symbol === symbol);
  }

  require(symbol: unknown): string {
    if (!this.has(symbol)) throw new BadRequestException('Невідомий інструмент');
    return symbol;
  }

  list() {
    return this.instruments.map(({ symbol, baseAsset, quoteAsset, tickSize, lotSize, minQty, maxQty, maxPrice }) => ({
      symbol, baseAsset, quoteAsset, tickSize, lotSize, minQty, maxQty, maxPrice,
    }));
  }
}
