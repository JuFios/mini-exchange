import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { engineCall } from './engine-call';

export interface TerminalOrder {
  orderId: string;
  instrument: string;
  status: 'filled' | 'cancelled';
  closedAt: string;
}

export interface LiveOrder {
  orderId: string;
  userId: string;
  instrument: string;
  createdAt: string;
}

@Injectable()
export class EngineOrdersClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow('ENGINE_INTERNAL_URL');
    this.token = config.getOrThrow('RECONCILIATION_TOKEN');
  }

  /** Із переданих заявок (не більше 1000) повертає ті, що вже filled або cancelled. */
  async terminal(orderIds: string[], signal?: AbortSignal): Promise<TerminalOrder[]> {
    if (orderIds.length === 0) return [];
    const { orders } = await engineCall<{ orders: TerminalOrder[] }>(
      'orders',
      new URL('/internal/orders/terminal', this.url),
      this.token,
      {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderIds }),
      },
    );
    return orders;
  }

  /** Сторінка (до 1000) заявок у книзі, прийнятих із резервом, з `orderId` більшим за `after`. */
  async live(after: string, instrument?: string, signal?: AbortSignal): Promise<LiveOrder[]> {
    const { orders } = await engineCall<{ orders: LiveOrder[] }>(
      'orders',
      new URL('/internal/orders/live', this.url),
      this.token,
      {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ after, ...(instrument && { instrument }) }),
      },
    );
    return orders;
  }
}
