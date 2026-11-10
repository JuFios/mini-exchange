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

interface Waiting {
  sockets: Set<Socket>;
  done: Promise<void>;
}

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
  private readonly reads = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, Waiting>();
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
    // Сокет, що вже розірвано, не повинен ні займати читання, ні потрапляти до кімнати.
    if (!client.connected) return;
    client.join(instrument);
    try {
      await this.requestBook(instrument, client);
    } catch {
      return { ok: false, error: 'Книга тимчасово недоступна' };
    }
  }

  async broadcastDepth(instrument: string) {
    await this.exclusive(instrument, () => this.push(instrument));
  }

  /**
   * Підписники, які чекають на книгу, ділять одне читання: скільки б викликів `subscribe` не
   * надійшло, у черзі інструмента лишається не більше однієї пачки, що ще не почалась. Склад
   * пачки закривається в момент початку читання, тож пізніша підписка йде в наступну й
   * отримує книгу не старішу за свій вхід у кімнату. Пачка, у якої не лишилось живих сокетів,
   * не читає книгу взагалі.
   */
  private requestBook(instrument: string, client: Socket): Promise<void> {
    let batch = this.waiting.get(instrument);
    if (!batch) {
      const sockets = new Set<Socket>();
      // Задача виконується не раніше наступного тіку, тож `created` до цього часу вже заповнено.
      const created: Waiting = { sockets, done: Promise.resolve() };
      created.done = this.exclusive(instrument, async () => {
        if (this.waiting.get(instrument) === created) this.waiting.delete(instrument);
        if (![...sockets].some((socket) => socket.connected)) return;
        const { bids, asks } = await this.orderBook.read(instrument);
        for (const socket of sockets) if (socket.connected) socket.emit('book', { bids, asks });
      });
      this.waiting.set(instrument, created);
      batch = created;
    }
    batch.sockets.add(client);
    return batch.done;
  }

  private async push(instrument: string): Promise<void> {
    const { bids, asks } = await this.orderBook.read(instrument);
    this.server.to(instrument).emit('book', { bids, asks });
  }

  /** Читання одного інструмента не перетинаються: пізніше завершене не може бути старішим. */
  private exclusive(instrument: string, task: () => Promise<void>): Promise<void> {
    const result = (this.reads.get(instrument) ?? Promise.resolve()).then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.reads.set(instrument, tail);
    void tail.then(() => {
      if (this.reads.get(instrument) === tail) this.reads.delete(instrument);
    });
    return result;
  }

  private schedule(instrument: string): void {
    // Без підписників книгу не читаємо; серія команд збирається в одне читання. Запис лишається
    // до початку читання, тож за повільного читання черга не росте більше ніж на одне.
    if (this.pending.has(instrument) || !this.server.sockets.adapter.rooms.get(instrument)?.size)
      return;
    const timer = setTimeout(() => {
      this.exclusive(instrument, () => {
        this.pending.delete(instrument);
        return this.push(instrument);
      }).catch((error: unknown) =>
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
