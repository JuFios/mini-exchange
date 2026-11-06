import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OrderBookService } from '../order-book.service';
import { InstrumentCatalog } from '../instrument-catalog';

/**
 * Трансляція оновлень order book підписаним клієнтам. Кожен клієнт
 * підписується на конкретний інструмент і отримує знімок глибини ринку
 * після кожної зміни.
 *
 * NOTE (стартовий код): повідомлення не мають номера послідовності —
 * клієнт не може самостійно виявити, що пропустив оновлення під час
 * розриву з'єднання. Це відповідає одній з категорій проблем у ТЗ.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly orderBook: OrderBookService,
    private readonly instruments: InstrumentCatalog,
  ) {}

  handleConnection(client: Socket) {
    client.emit('connected', { message: 'ok' });
  }

  @SubscribeMessage('subscribe')
  subscribe(client: Socket, instrument: unknown) {
    if (!this.instruments.has(instrument)) {
      return { ok: false, error: 'Невідомий інструмент' };
    }
    client.join(instrument);
    client.emit('book', this.orderBook.depth(instrument));
  }

  broadcastDepth(instrument: string) {
    this.server.to(instrument).emit('book', this.orderBook.depth(instrument));
  }
}
