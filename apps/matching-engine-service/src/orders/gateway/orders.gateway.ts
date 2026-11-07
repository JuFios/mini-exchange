import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { CommittedBook } from '../../engine/committed-book';
import { InstrumentCatalog } from '../instrument-catalog';

// Legacy-підписка повертає committed snapshot без номера послідовності.
// Для виявлення пропущених оновлень потрібен sequence-протокол.
@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly orderBook: CommittedBook,
    private readonly instruments: InstrumentCatalog,
  ) {}

  handleConnection(client: Socket) {
    client.emit('connected', { message: 'ok' });
  }

  @SubscribeMessage('subscribe')
  async subscribe(client: Socket, instrument: unknown) {
    if (!this.instruments.has(instrument)) {
      return { ok: false, error: 'Невідомий інструмент' };
    }
    client.join(instrument);
    try {
      const { bids, asks } = await this.orderBook.read(instrument);
      client.emit('book', { bids, asks });
    } catch {
      return { ok: false, error: 'Книга тимчасово недоступна' };
    }
  }

  async broadcastDepth(instrument: string) {
    const { bids, asks } = await this.orderBook.read(instrument);
    this.server.to(instrument).emit('book', { bids, asks });
  }
}
