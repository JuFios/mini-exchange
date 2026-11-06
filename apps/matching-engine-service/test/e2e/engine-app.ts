import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { migrate } from '../../src/database/migrate';
import { testDatabase } from '../test-database';
import { configureApp } from '../../src/configure-app';
import type { Order } from '../../src/orders/entities/order.entity';
import { EngineEnv, validateEnv } from '../../src/config/env.validation';

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

  async function start(overrides?: Partial<EngineEnv>) {
    const { AppModule } = await import('../../src/app.module');
    const builder = Test.createTestingModule({ imports: [AppModule] });
    if (overrides) {
      const config = { ...validateEnv(process.env), ...overrides };
      builder.overrideProvider(ConfigService).useValue({ getOrThrow: (key: keyof EngineEnv) => config[key] });
    }
    const module = await builder.compile();
    const instance = module.createNestApplication({ rawBody: true, logger: ['error'], abortOnError: false });
    try {
      configureApp(instance);
      await instance.listen(0, '127.0.0.1');
      baseUrl = await instance.getUrl();
      app = instance;
    } catch (error) {
      await instance.close();
      throw error;
    }
  }

  async function close() {
    const instance = app;
    app = undefined;
    await instance?.close();
  }

  async function restart(overrides?: Partial<EngineEnv>) {
    await close();
    await start(overrides);
  }

  beforeEach(() => start());

  afterEach(async () => {
    // Заявки одного тесту не повинні потрапити в книгу наступного після її відновлення при старті.
    try {
      await app?.get(DataSource).query('TRUNCATE TABLE orders');
    } finally {
      await close();
    }
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

  return { request, register, submit, list, restart, database: () => app!.get(DataSource), url: () => baseUrl };
}
