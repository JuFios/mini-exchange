import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';

interface Waiter {
  seq: string;
  finish: () => void;
}

@Injectable()
export class PgNotifications implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgNotifications.name);
  private client?: Client;
  private reconnect?: NodeJS.Timeout;
  private connecting?: Promise<void>;
  private stopped = false;
  private readonly waiters = new Map<string, Set<Waiter>>();
  readonly commandListeners = new Set<(instrument: string) => void>();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new Client({
      host: this.config.getOrThrow('DATABASE_HOST'),
      port: this.config.getOrThrow('DATABASE_PORT'),
      user: this.config.getOrThrow('DATABASE_USER'),
      password: this.config.getOrThrow('DATABASE_PASSWORD'),
      database: this.config.getOrThrow('DATABASE_NAME'),
      connectionTimeoutMillis: 3000,
      application_name: `engine-listen:${this.config.getOrThrow('INSTANCE_ID')}`,
    });
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      void client.end().catch(() => undefined);
      if (!this.stopped && !this.reconnect)
        this.reconnect = setTimeout(() => {
          this.reconnect = undefined;
          this.connecting = this.connect().finally(() => {
            this.connecting = undefined;
          });
        }, 100);
    };
    client.on('error', lost);
    client.on('end', lost);
    client.on('notification', ({ channel, payload }) => {
      if (channel === 'engine_commands' && payload) {
        for (const listener of this.commandListeners) listener(payload);
      }
      if (channel === 'order_applied' && payload) {
        const [orderId, seq] = payload.split(':');
        for (const waiter of [...(this.waiters.get(orderId) ?? [])]) {
          if (waiter.seq === seq) waiter.finish();
        }
      }
    });
    try {
      await client.connect();
      await client.query('LISTEN order_applied; LISTEN engine_commands');
      if (this.stopped) await client.end();
    } catch {
      this.logger.error({ alert: 'notification_connection_lost' });
      lost();
    }
  }

  wait(orderId: string, seq: string, milliseconds: number) {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const set = this.waiters.get(orderId) ?? new Set<Waiter>();
    const waiter: Waiter = {
      seq,
      finish: () => {
        cleanup();
        finish();
      },
    };
    const cleanup = () => {
      clearTimeout(timer);
      set.delete(waiter);
      if (set.size === 0) this.waiters.delete(orderId);
    };
    set.add(waiter);
    this.waiters.set(orderId, set);
    const timer = setTimeout(waiter.finish, milliseconds);
    return { ready, cancel: cleanup };
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnect);
    await this.connecting;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
    for (const set of this.waiters.values()) for (const waiter of [...set]) waiter.finish();
  }
}
