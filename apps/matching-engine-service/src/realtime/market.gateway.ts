import { OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { CommittedBook } from '../engine/committed-book';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { MarketEvent, publicDelta, publicTrade } from './realtime-events';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { ReplicaLagMonitor } from './replica-lag.monitor';
import { refuseWhileStale } from './replica-guard';

export const bookRoom = (instrument: string) => `book:${instrument}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Публічний namespace: snapshot, `book.delta` з номером команди, `trade` і `book.heartbeat`. */
@WebSocketGateway({ namespace: 'market', transports: ['websocket'], cors: { origin: '*' } })
export class MarketGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Namespace;

  private readonly instance: string;
  private readonly detach: (() => void)[] = [];

  constructor(
    config: ConfigService,
    private readonly reader: RealtimeStreamReader,
    private readonly monitor: ReplicaLagMonitor,
    private readonly book: CommittedBook,
    private readonly instruments: InstrumentCatalog,
  ) {
    this.instance = config.getOrThrow<string>('INSTANCE_ID');
  }

  afterInit(server: Namespace): void {
    server.use(refuseWhileStale(this.monitor));
    this.detach.push(
      this.reader.onMarket((event) => this.publish(event)),
      // Heartbeat несе seq з PG, а не останній роздано цією реплікою: інакше завислий
      // читач лишав би клієнтів `live` на застарілій книзі.
      this.monitor.onHeartbeat((instrument, seq) =>
        server.to(bookRoom(instrument)).emit('book.heartbeat', { instrument, seq }),
      ),
      this.monitor.onStale(() => server.disconnectSockets(true)),
    );
  }

  onModuleDestroy(): void {
    for (const detach of this.detach.splice(0)) detach();
  }

  /**
   * Кімнату приєднують до snapshot: будь-яка команда, закомічена після snapshot, публікується
   * вже після приєднання, тож клієнт не втрачає delta між snapshot і першою подією.
   */
  @SubscribeMessage('book.subscribe')
  async subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const instrument = isRecord(body) ? body.instrument : undefined;
    if (!this.instruments.has(instrument)) return { ok: false, error: 'UNKNOWN_INSTRUMENT' };
    const room = bookRoom(instrument);
    // Повторна підписка (resync) не повинна виселяти сокет, який уже в кімнаті: інакше збій
    // читання snapshot лишив би клієнта без delta і heartbeat, які він використовує для перевірки.
    const joined = !client.rooms.has(room);
    await client.join(room);
    try {
      return { ok: true, instance: this.instance, snapshot: await this.book.read(instrument) };
    } catch (error) {
      if (joined) await client.leave(room);
      return { ok: false, error: errorCode(error) };
    }
  }

  @SubscribeMessage('book.unsubscribe')
  async unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const instrument = isRecord(body) ? body.instrument : undefined;
    if (!this.instruments.has(instrument)) return { ok: false, error: 'UNKNOWN_INSTRUMENT' };
    await client.leave(bookRoom(instrument));
    return { ok: true };
  }

  private publish(event: MarketEvent): void {
    const room = this.server.to(bookRoom(event.payload.instrument));
    if (event.type === 'book.delta') room.emit('book.delta', publicDelta(event.payload));
    else room.emit('trade', publicTrade(event.payload));
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ServiceUnavailableException) {
    const body = error.getResponse();
    if (isRecord(body) && typeof body.code === 'string') return body.code;
  }
  return 'BOOK_UNAVAILABLE';
}
