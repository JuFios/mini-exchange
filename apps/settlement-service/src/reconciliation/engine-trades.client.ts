import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { engineCall } from './engine-call';
import type { EngineTrade } from './trade-comparison';

const PAGE_SIZE = 1000;

interface Page {
  trades: EngineTrade[];
  next: string | null;
}

export interface Period {
  from: string;
  to: string;
  instrument?: string;
}

@Injectable()
export class EngineTradesClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow('ENGINE_INTERNAL_URL');
    this.token = config.getOrThrow('RECONCILIATION_TOKEN');
  }

  async *trades(period: Period, signal?: AbortSignal): AsyncGenerator<EngineTrade> {
    let after: string | null = null;
    do {
      const page: Page = await this.page(period, after, signal);
      yield* page.trades;
      after = page.next;
    } while (after);
  }

  private async page(
    { from, to, instrument }: Period,
    after: string | null,
    signal?: AbortSignal,
  ): Promise<Page> {
    const url = new URL('/internal/trades', this.url);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (instrument) url.searchParams.set('instrument', instrument);
    if (after) url.searchParams.set('after', after);
    return engineCall<Page>('trades', url, this.token, { signal });
  }
}
