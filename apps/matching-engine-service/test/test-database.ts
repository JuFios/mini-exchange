import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from '../src/config/env.validation';
import { engineDataSourceOptions } from '../src/data-source';

export function testDatabase() {
  const name = `exchange_e2e_${randomUUID().replaceAll('-', '')}`;
  const env = {
    DATABASE_HOST: process.env.DATABASE_HOST ?? '127.0.0.1',
    DATABASE_PORT: process.env.DATABASE_PORT ?? '5433',
    DATABASE_USER: process.env.DATABASE_USER ?? 'exchange',
    DATABASE_PASSWORD: process.env.DATABASE_PASSWORD ?? 'exchange',
    DATABASE_NAME: name,
  };
  const options = engineDataSourceOptions(validateDatabaseEnv(env));
  const admin = new DataSource({
    ...options,
    database: process.env.DATABASE_NAME ?? 'postgres',
    connectTimeoutMS: 3000,
  });
  let created = false;

  return {
    env,
    source: () => new DataSource(options),
    async create() {
      await admin.initialize();
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
    },
    async destroy() {
      if (!admin.isInitialized) return;
      try {
        if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      } finally {
        await admin.destroy();
      }
    },
  };
}
