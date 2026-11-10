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

// Невдале читання повторюється через ці паузи; після вичерпання кімнату розривають, і клієнт
// сам перепідключається та підписується заново. Без seq застарілу книгу інакше не помітити.
export const LEGACY_PUSH_RETRY_MS = [100, 400, 1600];

interface Waiting {
  sockets: Set<Socket>;
  done: Promise<void>;
}

/**
 * Застаріла сумісність зі starter (namespace `/`): `subscribe` повертає агреговану книгу без
 * номера послідовності, а після кожної зміни книги надходить нова. Виявити пропуск тут
 * неможливо, тому нові клієнти використовують namespace `/market`.
 */
@WebSocketGateway({ transports: ['websocket'] })
export class OrdersGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(OrdersGateway.name);
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, Waiting>();
  // Скільки розсилок інструмента поспіль не вдалося; скидається першою вдалою.
  private readonly failures = new Map<string, number>();
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
      // Пропущені delta не скличуть розсилку, а без `seq` клієнт прогалини не помітить.
      this.reader.onGap((stream) => {
        const instrument = /^exchange:market:\{(.+)\}$/.exec(stream)?.[1];
        if (instrument) this.schedule(instrument);
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
    if (!this.server.sockets.adapter.rooms.get(instrument)?.size) {
      this.failures.delete(instrument);
      return;
    }
    if (this.pending.has(instrument)) return;
    const failed = this.failures.get(instrument) ?? 0;
    const timer = setTimeout(
      () => {
        this.exclusive(instrument, () => {
          this.pending.delete(instrument);
          return this.push(instrument);
        }).then(
          () => this.failures.delete(instrument),
          (error: unknown) => this.pushFailed(instrument, error),
        );
      },
      failed === 0 ? LEGACY_BOOK_THROTTLE_MS : LEGACY_PUSH_RETRY_MS[failed - 1],
    );
    timer.unref();
    this.pending.set(instrument, timer);
  }

  /**
   * Книга без `seq`: пропущену розсилку клієнт не помітить, а нової команди може не бути. Тому
   * повторюємо з паузами, а коли спроби вичерпано, розриваємо кімнату: клієнт підключається
   * знову й бере свіжу книгу.
   */
  private pushFailed(instrument: string, error: unknown): void {
    const failed = (this.failures.get(instrument) ?? 0) + 1;
    this.logger.warn({
      alert: 'legacy_book_push_failed',
      attempt: failed,
      message: error instanceof Error ? error.message : String(error),
    });
    if (failed > LEGACY_PUSH_RETRY_MS.length) {
      this.failures.delete(instrument);
      this.server.in(instrument).disconnectSockets(true);
      return;
    }
    this.failures.set(instrument, failed);
    this.schedule(instrument);
  }
}
