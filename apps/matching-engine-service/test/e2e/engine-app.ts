import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';
import { configureApp } from '../../src/configure-app';
import type { Order } from '../../src/orders/entities/order.entity';

export function engineApp() {
  const database = testDatabase();
  const example = parseEnv(readFileSync(join(__dirname, '../../.env.example'), 'utf8'));
  const settings = {
    ...example,
    ...database.env,
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT ?? '6379',
  };
  let app: INestApplication | undefined;
  let baseUrl: string;
  const original = new Map<string, string | undefined>();

  beforeAll(async () => {
    const redis = new Redis({
      host: settings.REDIS_HOST,
      port: Number(settings.REDIS_PORT),
      connectTimeout: 3000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    try {
      expect(await redis.ping()).toBe('PONG');
    } finally {
      redis.disconnect();
    }
    await database.create();
    const source = database.source();
    await source.initialize();
    try {
      await migrate(source, 'run');
    } finally {
      await source.destroy();
    }
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      original.set(key, process.env[key]);
      process.env[key] = value;
    }
  });

  beforeEach(async () => {
    const { AppModule } = await import('../../src/app.module');
    app = await NestFactory.create(AppModule, { rawBody: true, logger: ['error'], abortOnError: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterEach(async () => {
    // Заявки одного тесту не повинні потрапити в книгу наступного після її відновлення при старті.
    await app?.get(DataSource).query('TRUNCATE TABLE orders');
    await app?.close();
    app = undefined;
  });

  afterAll(async () => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await database.destroy();
  });

  function request(path: string, method = 'GET', token?: string, body?: unknown) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  async function register(): Promise<string> {
    const response = await request('/auth/register', 'POST', undefined, {
      email: `${randomUUID()}@example.test`,
      password: 'example-password',
    });
    expect(response.status).toBe(201);
    const { accessToken } = (await response.json()) as { accessToken: string };
    return accessToken;
  }

  function submit(token: string, changes: Record<string, unknown> = {}) {
    return request('/orders', 'POST', token, {
      instrument: 'ABC',
      side: 'sell',
      price: 100,
      quantity: 1,
      ...changes,
    });
  }

  async function list(token: string): Promise<Order[]> {
    const response = await request('/orders', 'GET', token);
    expect(response.status).toBe(200);
    return (await response.json()) as Order[];
  }

  return { request, register, submit, list, url: () => baseUrl };
}
