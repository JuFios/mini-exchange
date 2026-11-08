import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { PG_SESSION_OPTIONS } from '../database/session-options';

// Recovery тримає lock_timeout 3 с і журнал до 10 с; nginx читає відповідь до 15 с.
const PUBLISH_WAIT_MS = 2000;
const RESUME_ACK_WAIT_MS = 3000;
const RESUME_RESULT_WAIT_MS = 12000;

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
  private ready = false;
  private publishing = Promise.resolve();
  private readonly waiters = new Map<string, Set<Waiter>>();
  readonly resumeListeners = new Set<(request: { instrument: string; id: string }) => void>();
  private readonly resumeWaiters = new Map<string, (ok: boolean) => void>();
  private readonly resumeAcks = new Map<string, () => void>();
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
      options: PG_SESSION_OPTIONS,
      application_name: `engine-listen:${this.config.getOrThrow('INSTANCE_ID')}`,
    });
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = undefined;
      this.ready = false;
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
      if ((channel === 'engine_resume' || channel === 'engine_resume_result') && payload) {
        try {
          const request = JSON.parse(payload);
          if (channel === 'engine_resume')
            for (const listener of this.resumeListeners) listener(request);
          else if (request.ack) this.resumeAcks.get(request.id)?.();
          else this.resumeWaiters.get(request.id)?.(request.ok);
        } catch {
          /* Некоректне сповіщення не впливає на worker. */
        }
      }
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
      await client.query(
        'LISTEN order_applied; LISTEN engine_commands; LISTEN engine_resume; LISTEN engine_resume_result',
      );
      if (this.stopped) await client.end();
      else if (this.client === client) this.ready = true;
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

  // expired: запит уже відповів, тож власнику його надсилати немає сенсу.
  private publish(channel: string, payload: unknown, expired?: () => boolean): Promise<void> {
    const client = this.client;
    const task = this.publishing.then(async () => {
      if (expired?.()) return;
      if (!client || !this.ready || this.client !== client)
        throw new Error('Notification connection unavailable');
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Notification publish timed out')),
          PUBLISH_WAIT_MS,
        );
      });
      try {
        await Promise.race([
          client.query('SELECT pg_notify($1,$2)', [channel, JSON.stringify(payload)]),
          timedOut,
        ]);
      } catch (error) {
        // Запит без відповіді блокував би всю чергу; розрив запускає перепідключення.
        if (error instanceof Error && error.message === 'Notification publish timed out')
          (
            client as unknown as { connection?: { stream?: { destroy(): void } } }
          ).connection?.stream?.destroy();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    this.publishing = task.catch(() => undefined);
    return task;
  }

  // Власник підтверджує отримання одразу: відсутній власник дає 503 за RESUME_ACK_WAIT_MS,
  // а довге recovery не обривається через той самий короткий таймаут. Дедлайн ack іде від
  // виклику й охоплює чергу публікацій: відповідь не чекає на publish, а прострочений запит
  // не публікується.
  async requestResume(instrument: string): Promise<boolean | undefined> {
    const id = randomUUID();
    let settled = false;
    let finish!: (ok: boolean | undefined) => void;
    const result = new Promise<boolean | undefined>((resolve) => {
      finish = (ok) => {
        settled = true;
        resolve(ok);
      };
    });
    let timer = setTimeout(() => finish(undefined), RESUME_ACK_WAIT_MS);
    this.resumeWaiters.set(id, finish);
    this.resumeAcks.set(id, () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(undefined), RESUME_RESULT_WAIT_MS);
    });
    void this.publish('engine_resume', { instrument, id }, () => settled).catch(() =>
      finish(undefined),
    );
    try {
      return await result;
    } finally {
      settled = true;
      clearTimeout(timer);
      this.resumeWaiters.delete(id);
      this.resumeAcks.delete(id);
    }
  }

  async ackResume(id: string): Promise<void> {
    await this.publish('engine_resume_result', { id, ack: true });
  }

  async answerResume(id: string, ok: boolean): Promise<void> {
    await this.publish('engine_resume_result', { id, ok });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnect);
    await this.connecting;
    await this.publishing;
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
    for (const set of this.waiters.values()) for (const waiter of [...set]) waiter.finish();
  }
}
