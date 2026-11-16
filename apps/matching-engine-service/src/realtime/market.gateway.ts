import { rateLimited } from '../observability/metrics';
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
import { marketStream } from '../outbox/streams';
import { MarketEvent, publicDelta, publicTrade } from './realtime-events';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { ReplicaLagMonitor } from './replica-lag.monitor';
import { refuseWhileStale } from './replica-guard';

export const bookRoom = (instrument: string) => `book:${instrument}`;

// Скільки підписок і відписок одного сокета на один інструмент може стояти в черзі. Решта
// відхиляється одразу: інакше неавтентифікований сокет ставив би в чергу тисячі читань snapshot.
export const MAX_QUEUED_PER_SOCKET = 4;
const TOO_MANY = { ok: false, error: 'TOO_MANY_REQUESTS' } as const;

type BookSnapshot = Awaited<ReturnType<CommittedBook['read']>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Публічний namespace: snapshot, delta, угоди та сигнали свіжості. */
@WebSocketGateway({ namespace: 'market', transports: ['websocket'] })
export class MarketGateway implements OnGatewayInit, OnModuleDestroy {
  @WebSocketServer()
  server: Namespace;

  private readonly instance: string;
  private readonly subscribeLimit: number;
  private readonly subscribeWindows = new WeakMap<Socket, { until: number; count: number }>();
  private readonly detach: (() => void)[] = [];
  private readonly queues = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private readonly batches = new Map<string, Promise<BookSnapshot>>();
  private readonly reading = new Map<string, Promise<void>>();

  constructor(
    config: ConfigService,
    private readonly reader: RealtimeStreamReader,
    private readonly monitor: ReplicaLagMonitor,
    private readonly book: CommittedBook,
    private readonly instruments: InstrumentCatalog,
  ) {
    this.instance = config.getOrThrow<string>('INSTANCE_ID');
    this.subscribeLimit = config.getOrThrow<number>('WS_SUBSCRIBE_RATE_LIMIT');
  }

  afterInit(server: Namespace): void {
    server.use(refuseWhileStale(this.monitor));
    this.detach.push(
      this.reader.onMarket((event) => this.publish(event)),
      this.reader.onGap((stream) => {
        const instrument = this.instruments
          .list()
          .find(({ symbol }) => marketStream(symbol) === stream);
        if (instrument) {
          server
            .to(bookRoom(instrument.symbol))
            .emit('book.resync', { instrument: instrument.symbol });
        }
      }),
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
  subscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const now = performance.now();
    let window = this.subscribeWindows.get(client);
    if (!window || window.until <= now) {
      window = { until: now + 10_000, count: 0 };
      this.subscribeWindows.set(client, window);
    }
    if (window.count >= this.subscribeLimit) {
      rateLimited.inc({ scope: 'ws_subscribe' });
      return { ok: false, error: 'RATE_LIMITED' };
    }
    window.count++;
    const instrument = isRecord(body) ? body.instrument : undefined;
    if (!this.instruments.has(instrument)) return { ok: false, error: 'UNKNOWN_INSTRUMENT' };
    if (!client.connected) return { ok: false, error: 'DISCONNECTED' };
    return this.inOrder(client, instrument, TOO_MANY, async () => {
      // Запит, що простояв у черзі, міг дочекатися розриву: читати snapshot для нього зайве.
      if (!client.connected) return { ok: false, error: 'DISCONNECTED' };
      const room = bookRoom(instrument);
      // Повторна підписка (resync) не повинна виселяти сокет, який уже в кімнаті: інакше збій
      // читання snapshot лишив би клієнта без delta і heartbeat, які він використовує для перевірки.
      const joined = !client.rooms.has(room);
      await client.join(room);
      try {
        return { ok: true, instance: this.instance, snapshot: await this.snapshot(instrument) };
      } catch (error) {
        if (joined) await client.leave(room);
        return { ok: false, error: errorCode(error) };
      }
    });
  }

  @SubscribeMessage('book.unsubscribe')
  unsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: unknown) {
    const instrument = isRecord(body) ? body.instrument : undefined;
    if (!this.instruments.has(instrument)) return { ok: false, error: 'UNKNOWN_INSTRUMENT' };
    return this.inOrder(client, instrument, TOO_MANY, async () => {
      await client.leave(bookRoom(instrument));
      return { ok: true };
    });
  }

  /**
   * Підписки одного сокета на один інструмент виконуються по черзі: невдала повільна підписка
   * інакше виселила б сокет з кімнати, у яку вже приєднала успішна пізніша.
   */
  private inOrder<T, R>(
    client: Socket,
    instrument: string,
    refused: R,
    task: () => Promise<T>,
  ): Promise<T | R> {
    const key = `${client.id}:${instrument}`;
    const depth = this.depths.get(key) ?? 0;
    if (depth >= MAX_QUEUED_PER_SOCKET) return Promise.resolve(refused);
    this.depths.set(key, depth + 1);
    const result = (this.queues.get(key) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      const left = (this.depths.get(key) ?? 1) - 1;
      if (left > 0) this.depths.set(key, left);
      else this.depths.delete(key);
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return result;
  }

  /**
   * Підписки на інструмент ділять читання snapshot: одночасно йде не більше одного, і чекає не
   * більше однієї пачки. Ліміт на сокет не тримав би навантаження на PG: з багатьох сокетів і
   * адрес читання займали б усі слоти `CommittedBook`, і REST-читання книги отримували б 503.
   * Пачка закривається, коли читання отримало слот: snapshot PG береться пізніше, тож він не
   * старіший за вхід сокета в кімнату. Підписка, що прийшла, поки читання стоїть у черзі слотів,
   * чекає його, а не ще одну чергу.
   */
  private snapshot(instrument: string): Promise<BookSnapshot> {
    const waiting = this.batches.get(instrument);
    if (waiting) return waiting;
    const signal = AbortSignal.timeout(3000);
    const close = () => {
      if (this.batches.get(instrument) === batch) this.batches.delete(instrument);
    };
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new ServiceUnavailableException({ code: 'BOOK_UNAVAILABLE' }));
      signal.addEventListener('abort', abort, { once: true });
    });
    const reading = (this.reading.get(instrument) ?? Promise.resolve()).then(() => {
      signal.throwIfAborted();
      return this.book.read(instrument, undefined, close, signal);
    });
    const batch: Promise<BookSnapshot> = Promise.race([reading, cancelled]);
    this.batches.set(instrument, batch);
    const finish = () => {
      close();
      signal.removeEventListener('abort', abort);
    };
    const tail = batch.then(finish, finish);
    this.reading.set(instrument, tail);
    void tail.then(() => {
      if (this.reading.get(instrument) === tail) this.reading.delete(instrument);
    });
    return batch;
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
