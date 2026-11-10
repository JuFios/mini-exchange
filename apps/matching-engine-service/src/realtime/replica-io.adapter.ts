import { wsClients } from '../observability/metrics';
import type { IncomingMessage } from 'node:http';
import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import { ReplicaLagMonitor } from './replica-lag.monitor';

const UNAVAILABLE =
  'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

/**
 * Нездорова репліка відповідає 503 вже на HTTP-запит upgrade, і nginx повторює його на іншій
 * репліці. Відмова в middleware namespace приходить після 101, коли вибір репліки неможливий.
 * Стандартна відмова `allowRequest` у engine.io дає 400, який nginx не вважає збоєм upstream.
 */
export class ReplicaIoAdapter extends IoAdapter {
  constructor(private readonly context: INestApplicationContext) {
    super(context);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const server: Server = super.createIOServer(port, {
      ...options,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, success: boolean) => void,
      ) => {
        if (this.context.get(ReplicaLagMonitor).healthy()) return callback(null, true);
        // Колбек не викликається: відповідь уже надіслано, а engine.io надіслав би власну.
        request.socket.end(UNAVAILABLE);
      },
    });
    server.engine.on('connection', (socket) => {
      wsClients.inc();
      socket.once('close', () => wsClients.dec());
    });
    return server;
  }
}
