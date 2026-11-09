import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { CommittedBook } from '../../engine/committed-book';
import { RealtimeStreamReader } from '../../realtime/realtime-stream-reader.service';
import { refuseWhileStale } from '../../realtime/replica-guard';
import { ReplicaLagMonitor } from '../../realtime/replica-lag.monitor';
import { InstrumentCatalog } from '../instrument-catalog';

// Після серії команд клієнт отримує одну свіжу книгу, а не по події на кожну.
export const LEGACY_BOOK_THROTTLE_MS = 100;

/**
 * Застаріла сумісність зі starter (namespace `/`): `subscribe` повертає агреговану книгу без
 * номера послідовності, а після кожної зміни книги надходить нова. Виявити пропуск тут
 * неможливо, тому нові клієнти використовують namespace `/market`.
 */
@WebSocketGateway({ transports: ['websocket'], cors: { origin: '*' } })
export class OrdersGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OrdersGateway.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly orderBook: CommittedBook,
    private readonly instruments: InstrumentCatalog,
    private readonly reader: RealtimeStreamReader,
    private readonly monitor: ReplicaLagMonitor,
  ) {}

  afterInit(server: Server): void {
    server.use(refuseWhileStale(this.monitor));
    this.detach.push(
      this.reader.onMarket((event) => {
        if (event.type === 'book.delta') this.schedule(event.payload.instrument);
      }),
      this.monitor.onStale(() => server.disconnectSockets(true)),
    );
  }

  onModuleDestroy(): void {
    for (const detach of this.detach.splice(0)) detach();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

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

  private schedule(instrument: string): void {
    // Без підписників книгу не читаємо; серія команд збирається в одне читання.
    if (this.pending.has(instrument) || !this.server.sockets.adapter.rooms.get(instrument)?.size)
      return;
    const timer = setTimeout(() => {
      this.pending.delete(instrument);
      this.broadcastDepth(instrument).catch((error: unknown) =>
        // Наступна зміна книги повторить спробу; для застарілого каналу цього достатньо.
        this.logger.warn({
          alert: 'legacy_book_push_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }, LEGACY_BOOK_THROTTLE_MS);
    timer.unref();
    this.pending.set(instrument, timer);
  }
}
