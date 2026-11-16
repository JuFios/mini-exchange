import { LedgerLinks1793980800002 } from './migrations/1793980800002-ledger-links';
import { SettlementProgress1793980800001 } from './migrations/1793980800001-settlement-progress';
import { DataSourceOptions } from 'typeorm';
import type { LedgerDatabaseEnv } from './config/env.validation';
import { LedgerSchema1793980800000 } from './migrations/1793980800000-ledger-schema';

export function ledgerDataSourceOptions(
  env: LedgerDatabaseEnv,
): Extract<DataSourceOptions, { type: 'postgres' }> {
  return {
    type: 'postgres',
    host: env.LEDGER_DATABASE_HOST,
    port: env.LEDGER_DATABASE_PORT,
    username: env.LEDGER_DATABASE_USER,
    password: env.LEDGER_DATABASE_PASSWORD,
    database: env.LEDGER_DATABASE_NAME,
    migrations: [
      LedgerSchema1793980800000,
      SettlementProgress1793980800001,
      LedgerLinks1793980800002,
    ],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    extra: {
      connectionTimeoutMillis: 10000,
      options: '-c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000',
    },
  };
}
