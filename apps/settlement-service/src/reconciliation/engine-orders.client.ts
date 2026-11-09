import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { engineCall } from './engine-call';

export interface TerminalOrder {
  orderId: string;
  instrument: string;
  status: 'filled' | 'cancelled';
  closedAt: string;
}

@Injectable()
export class EngineOrdersClient {
  private readonly url: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow('ENGINE_INTERNAL_URL');
    this.token = config.getOrThrow('INTERNAL_API_TOKEN');
  }

  /** Із переданих заявок (не більше 1000) повертає ті, що вже filled або cancelled. */
  async terminal(orderIds: string[]): Promise<TerminalOrder[]> {
    if (orderIds.length === 0) return [];
    const { orders } = await engineCall<{ orders: TerminalOrder[] }>(
      'orders',
      new URL('/internal/orders/terminal', this.url),
      this.token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderIds }),
      },
    );
    return orders;
  }
}
