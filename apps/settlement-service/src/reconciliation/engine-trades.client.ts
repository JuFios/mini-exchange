import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EngineTrade } from './trade-comparison';

const PAGE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

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
    this.token = config.getOrThrow('INTERNAL_API_TOKEN');
  }

  async *trades(period: Period): AsyncGenerator<EngineTrade> {
    let after: string | null = null;
    do {
      const page: Page = await this.page(period, after);
      yield* page.trades;
      after = page.next;
    } while (after);
  }

  private async page({ from, to, instrument }: Period, after: string | null): Promise<Page> {
    const url = new URL('/internal/trades', this.url);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('limit', String(PAGE_SIZE));
    if (instrument) url.searchParams.set('instrument', instrument);
    if (after) url.searchParams.set('after', after);
    try {
      const response = await fetch(url, {
        redirect: 'error',
        headers: { 'x-internal-token': this.token },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as Page;
    } catch (error) {
      throw new BadGatewayException(`Engine trades are unavailable: ${(error as Error).message}`);
    }
  }
}
