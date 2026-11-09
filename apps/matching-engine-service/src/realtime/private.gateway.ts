import { OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayInit, WebSocketGateway } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { accessPrincipal, JwtPayload } from '../auth/strategies/jwt.strategy';
import { privateOrder, privateWallet, UserEvent } from './realtime-events';
import { RealtimeStreamReader } from './realtime-stream-reader.service';
import { ReplicaLagMonitor } from './replica-lag.monitor';
import { refuseWhileStale } from './replica-guard';

// setTimeout з більшою затримкою спрацював би одразу.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const userRoom = (userId: string) => `user:${userId.toLowerCase()}`;

/**
 * Приватний namespace: токен у handshake, кімната користувача визначається сервером за `sub`.
 * Події не мають `seq` і під час розриву губляться, тож клієнт перечитує REST після reconnect.
 */
@WebSocketGateway({ namespace: 'private', transports: ['websocket'], cors: { origin: '*' } })
export class PrivateGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  private server: Namespace;
  private readonly secret: string;
  private readonly detach: (() => void)[] = [];

  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
    private readonly reader: RealtimeStreamReader,
    private readonly monitor: ReplicaLagMonitor,
  ) {
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  afterInit(server: Namespace): void {
    this.server = server;
    server.use(refuseWhileStale(this.monitor));
    server.use((socket, next) => void this.authenticate(socket, next));
    this.detach.push(
      this.reader.onUser((event) => this.publish(event)),
      this.monitor.onStale(() => server.disconnectSockets(true)),
    );
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
    try {
      if (typeof token !== 'string' || token === '') throw new Error();
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.secret,
        algorithms: ['HS256'],
      });
      const { userId } = accessPrincipal(payload);
      socket.data = { userId, exp: payload.exp };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  }

  private publish(event: UserEvent): void {
    const room = this.server.to(userRoom(event.payload.userId));
    if (event.type === 'order.updated') room.emit('order.updated', privateOrder(event.payload));
    else room.emit('wallet.updated', privateWallet(event.payload));
  }
}
