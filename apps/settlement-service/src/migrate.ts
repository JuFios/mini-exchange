import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { DataSource } from 'typeorm';
import { validateDatabaseEnv } from './config/env.validation';
import { ledgerDataSourceOptions } from './data-source';
import { migrate } from './database/migrate';
import { backfillReservationTerms } from './reservations/backfill-reservation-terms';

function engineConfig() {
  const env = Object.fromEntries(
    ['HOST', 'PORT', 'USER', 'PASSWORD', 'NAME'].map((key) => [
      `LEDGER_DATABASE_${key}`,
      process.env[`DATABASE_${key}`],
    ]),
  );
  try {
    return validateDatabaseEnv(env);
  } catch {
    throw new Error(
      'Engine DATABASE_* settings are required to migrate active legacy reservations',
    );
  }
}

async function main(): Promise<void> {
  const action = process.argv[2];
  if (action !== 'run' && action !== 'revert')
    throw new Error('Expected migration action: run or revert');
  if (existsSync('.env')) loadEnvFile('.env');
  const source = new DataSource({
    ...ledgerDataSourceOptions(validateDatabaseEnv(process.env)),
    logging: ['schema', 'error'],
  });
  await source.initialize();
  try {
    await migrate(source, action);
    if (action === 'run') {
      await backfillReservationTerms(source, () =>
        new DataSource({ ...ledgerDataSourceOptions(engineConfig()), migrations: [] }).initialize(),
      );
    }
  } finally {
    await source.destroy();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
