import { Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service';
import { accessPrincipal, JwtPayload } from '../auth/strategies/jwt.strategy';
import { USER_EVENTS_STREAM } from '../outbox/streams';
import { privateOrder, privateWallet, UserEvent } from './realtime-events';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { ReplicaLagMonitor } from './replica-lag.monitor';
import { refuseWhileStale } from './replica-guard';

// setTimeout з більшою затримкою спрацював би одразу.
const MAX_TIMER_MS = 2 ** 31 - 1;
// Logout, повторне використання refresh і новий вхід відкликають сесію. Без звірки відкритий
// сокет отримував би приватні події до `exp`. Кожна репліка перевіряє лише власні сокети.
export const SESSION_CHECK_MS = 3000;
// Довше сокет не живе без підтвердженої сесії: збій чи зависання PG інакше продовжували б
// відкликану сесію до `exp`. Межа не залежить від часу запиту, тож разом із тіком дає ≤ 13 с.
export const SESSION_UNVERIFIED_MS = 10_000;

export const userRoom = (userId: string) => `user:${userId.toLowerCase()}`;

/**
 * Приватний namespace: токен у handshake, кімната користувача визначається сервером за `sub`.
 * Події не мають `seq` і під час розриву губляться, тож клієнт перечитує REST після reconnect.
 */
@WebSocketGateway({ namespace: 'private', transports: ['websocket'] })
export class PrivateGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private server: Namespace;
  private readonly secret: string;
  private readonly logger = new Logger(PrivateGateway.name);
  private readonly detach: (() => void)[] = [];
  private checking = false;

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
    private readonly reader: RealtimeStreamReader,
    private readonly monitor: ReplicaLagMonitor,
    private readonly auth: AuthService,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  afterInit(server: Namespace): void {
    this.server = server;
    server.use(refuseWhileStale(this.monitor));
    server.use((socket, next) => void this.authenticate(socket, next));
    this.detach.push(
      this.reader.onUser((event) => this.publish(event)),
      // Приватні події не мають `seq`, тож пропуск помітить лише сервер: клієнт перепідключається й читає REST.
      this.reader.onGap((stream) => {
        if (stream === USER_EVENTS_STREAM) server.disconnectSockets(false);
      }),
      this.monitor.onStale(() => server.disconnectSockets(true)),
    );
    const sessions = setInterval(() => void this.checkSessions(), SESSION_CHECK_MS);
    sessions.unref();
    this.detach.push(() => clearInterval(sessions));
  }

  onModuleDestroy(): void {
    for (const detach of this.detach.splice(0)) detach();
  }

  handleConnection(client: Socket): void {
    void client.join(userRoom(client.data.userId));
    // Сервер розриває сокет на `exp`: інакше протермінований токен тримав би з'єднання відкритим.
    // Без `true`: транспорт спільний із `/market`, тож закривається лише ця namespace.
    const timer = setTimeout(
      () => client.disconnect(),
      Math.min(Math.max(0, client.data.exp * 1000 - Date.now()), MAX_TIMER_MS),
    );
    timer.unref();
    client.once('disconnect', () => clearTimeout(timer));
  }

  private async authenticate(socket: Socket, next: (error?: Error) => void): Promise<void> {
    const token: unknown = socket.handshake.auth?.token;
    const checkedAt = performance.now();
    try {
      if (typeof token !== 'string' || token === '') throw new Error();
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.secret,
        algorithms: ['HS256'],
      });
      const { userId } = await accessPrincipal(payload, this.auth);
      socket.data = { userId, sid: payload.sid, exp: payload.exp, verifiedAt: checkedAt };
      // Перевірка токена асинхронна: репліка могла стати завислою після охорони, а розрив за
      // `onStale` відбувається лише раз, на переході, тож сокет, що прослизнув, лишився б.
      if (!this.monitor.healthy()) return next(new Error('REPLICA_UNAVAILABLE'));
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  }

  private async checkSessions(): Promise<void> {
    // Перевірка до запиту: зависла звірка не продовжує життя непідтверджених сокетів.
    const now = performance.now();
    for (const socket of [...this.server.sockets.values()]) {
      if (now - socket.data.verifiedAt > SESSION_UNVERIFIED_MS) socket.disconnect();
    }
    const sockets = [...this.server.sockets.values()];
    if (this.checking || sockets.length === 0) return;
    this.checking = true;
    try {
      const active = await this.auth.activeSessions(sockets.map(({ data }) => data));
      for (const socket of sockets) {
        const { userId, sid } = socket.data;
        if (active.has(`${userId}:${sid}`.toLowerCase())) socket.data.verifiedAt = now;
        else socket.disconnect();
      }
    } catch (error) {
      // Сокети лишаються до межі SESSION_UNVERIFIED_MS: короткий збій PG не розриває всіх.
      this.logger.warn({
        alert: 'private_session_check_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.checking = false;
    }
  }

  private publish(event: UserEvent): void {
    const room = userRoom(event.payload.userId);
    try {
      const target = this.server.to(room);
      if (event.type === 'order.updated') target.emit('order.updated', privateOrder(event.payload));
      else target.emit('wallet.updated', privateWallet(event.payload));
    } catch (error) {
      // Приватні події не мають `seq`: втрату клієнт не помітить. Він перечитає REST після
      // перепідключення, а сервер не повинен лишати його з вірою в застарілий стан.
      this.logger.error({
        alert: 'private_event_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      this.server.in(room).disconnectSockets(false);
    }
  }
}
