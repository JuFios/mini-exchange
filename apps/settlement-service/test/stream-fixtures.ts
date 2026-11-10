import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { SettlementConsumer } from '../src/consumer/settlement-consumer.service';
import { SettlementEventHandler } from '../src/consumer/settlement-event.handler';
import { SettlementStats } from '../src/consumer/settlement-stats';
import { DEAD_LETTER_STREAM, settlementStream } from '../src/consumer/streams';
import { ReservationsService } from '../src/reservations/reservations.service';
import { tradeFixture } from './ledger-app';

export const USER_EVENTS = 'exchange:user-events';
export const abcStream = settlementStream('ABC');
export type Trade = ReturnType<typeof tradeFixture>;

export function redisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
  });
}

/** Поля запису збігаються з outboxStreamFields в engine. */
export function streamFields(type: string, payload: object, producer = 'matching-engine') {
  const eventId = randomUUID();
  const envelope = {
    eventId,
    type,
    version: 1,
    instrument: 'ABC',
    seq: '1',
    occurredAt: new Date().toISOString(),
    producer,
    payload,
  };
  return [
    'eventId',
    eventId,
    'type',
    type,
    'version',
    '1',
    'instrument',
    'ABC',
    'seq',
    '1',
    'traceparent',
    '',
    'envelope',
    JSON.stringify(envelope),
  ];
}

export const tradeFields = (trade: Trade) => streamFields('trade.executed', trade);

export async function resetStreams(redis: Redis): Promise<void> {
  await redis.del(abcStream, settlementStream('XYZ'), DEAD_LETTER_STREAM, USER_EVENTS);
}

/** Резерви для обох сторін угоди з fixture: купівля 0.5 @ 101, продаж 0.5. */
export async function reserveTrade(app: INestApplication, trade: Trade): Promise<void> {
  const reservations = app.get(ReservationsService);
  await reservations.reserve({
    reservationId: trade.buyOrderId,
    userId: trade.buyerUserId,
    instrument: 'ABC',
    limitPrice: trade.buyLimitPrice,
    asset: 'USD',
    amount: '505000000000',
  });
  await reservations.reserve({
    reservationId: trade.sellOrderId,
    userId: trade.sellerUserId,
    instrument: 'ABC',
    limitPrice: '0.01',
    asset: 'ABC',
    amount: '50000000',
  });
}

export function startConsumer(
  app: INestApplication,
  settings: { claimIdleMs?: number; maxDeliveries?: number } = {},
  handler: Pick<SettlementEventHandler, 'handle'> = app.get(SettlementEventHandler),
) {
  const values: Record<string, unknown> = {
    CONSUMER_NAME: 'test-consumer',
    CONSUMER_CLAIM_IDLE_MS: settings.claimIdleMs ?? 200,
    CONSUMER_MAX_DELIVERIES: settings.maxDeliveries ?? 20,
    STREAM_MAXLEN: 1000,
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
    REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? 'exchange-redis-local-only',
  };
  const consumer = new SettlementConsumer(
    { getOrThrow: (key: string) => values[key] } as never,
    handler as SettlementEventHandler,
    app.get(DataSource),
    app.get(SettlementStats),
  );
  consumer.onApplicationBootstrap();
  return consumer;
}

export const pendingCount = async (redis: Redis, stream = abcStream): Promise<number> => {
  try {
    return ((await redis.xpending(stream, 'settlement')) as [number])[0];
  } catch {
    return 0;
  }
};
