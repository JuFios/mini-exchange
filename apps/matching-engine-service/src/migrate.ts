import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from './config/env.validation';
import { engineDataSourceOptions } from './data-source';
import { migrate } from './database/migrate';

async function main() {
  const action = process.argv[2];
  if (action !== 'run' && action !== 'revert')
    throw new Error('Expected migration action: run or revert');
  if (existsSync('.env')) loadEnvFile('.env');
  const source = new DataSource({
    ...engineDataSourceOptions(validateDatabaseEnv(process.env)),
    logging: ['schema', 'error'],
  });
  await source.initialize();
  try {
    await migrate(source, action);
  } finally {
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
