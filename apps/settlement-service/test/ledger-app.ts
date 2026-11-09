import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { configureApp } from '../src/configure-app';
import { validateDatabaseEnv } from '../src/config/env.validation';
import { ledgerDataSourceOptions } from '../src/data-source';
import { migrate } from '../src/database/migrate';

const demo = parseEnv(readFileSync(join(__dirname, '../.env.example'), 'utf8'));
export const internalToken = demo.INTERNAL_API_TOKEN!;

export function ledgerApp(overrides: Record<string, string> = {}) {
  const base = {
    LEDGER_DATABASE_HOST: process.env.LEDGER_DATABASE_HOST ?? '127.0.0.1',
    LEDGER_DATABASE_PORT: process.env.LEDGER_DATABASE_PORT ?? '5433',
    LEDGER_DATABASE_USER: process.env.LEDGER_DATABASE_USER ?? 'exchange',
    LEDGER_DATABASE_PASSWORD: process.env.LEDGER_DATABASE_PASSWORD ?? 'exchange',
    LEDGER_DATABASE_NAME: process.env.LEDGER_DATABASE_NAME ?? 'postgres',
  };
  const name = `ledger_e2e_${randomUUID().replaceAll('-', '')}`;
  const env = {
    ...demo,
    ...overrides,
    ...base,
    LEDGER_DATABASE_NAME: name,
    REDIS_HOST: process.env.REDIS_HOST ?? '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT ?? '6379',
  };
  const admin = new DataSource(ledgerDataSourceOptions(validateDatabaseEnv(base)));
  const options = ledgerDataSourceOptions(validateDatabaseEnv(env));
  const previous = new Map<string, string | undefined>();
  let created = false;
  let app: INestApplication;
  let source: DataSource;

  beforeAll(async () => {
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const database = new DataSource(options);
    await database.initialize();
    try {
      await migrate(database, 'run');
    } finally {
      await database.destroy();
    }
    for (const [key, value] of Object.entries(env)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }
    const { AppModule } = await import('../src/app.module');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ logger: ['error'], abortOnError: false });
    configureApp(app);
    await app.init();
    source = app.get(DataSource);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (admin.isInitialized) {
        try {
          if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        } finally {
          await admin.destroy();
        }
      }
    }
  });

  return {
    app: () => app,
    source: () => source,
    secondary: () => new DataSource(options),
    jwtSecret: demo.JWT_ACCESS_SECRET!,
  };
}

export function tradeFixture() {
  return {
    tradeId: randomUUID(),
    instrument: 'ABC',
    buyOrderId: randomUUID(),
    sellOrderId: randomUUID(),
    buyerUserId: randomUUID(),
    sellerUserId: randomUUID(),
    baseAsset: 'ABC',
    quoteAsset: 'USD',
    price: '100.00',
    quantity: '0.5',
    buyLimitPrice: '101.00',
    executedAt: '2026-01-01T10:00:00.000Z',
  } as const;
}
