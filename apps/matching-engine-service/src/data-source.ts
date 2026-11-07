import { LegacyOrdersAndTradeLookups1793980800003 } from './migrations/1793980800003-legacy-orders-and-trade-lookups';
import { RecoveryCounters1793980800002 } from './migrations/1793980800002-recovery-counters';
import { DataSourceOptions } from 'typeorm';
import { User } from './auth/entities/user.entity';
import { Order } from './orders/entities/order.entity';
import { Instrument } from './orders/entities/instrument.entity';
import { InstrumentState, OrderCommand, OrderRequest, Outbox, TradeRecord } from './database/engine-records';
import { InitialSchema1793980800000 } from './migrations/1793980800000-initial-schema';
import { Instruments1793980800001 } from './migrations/1793980800001-instruments';
import type { DatabaseEnv } from './config/env.validation';

export function engineDataSourceOptions(env: DatabaseEnv): Extract<DataSourceOptions, { type: 'postgres' }> {
  return {
    type: 'postgres',
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    entities: [User, Order, Instrument, InstrumentState, OrderCommand, OrderRequest, Outbox, TradeRecord],
    migrations: [InitialSchema1793980800000, Instruments1793980800001, RecoveryCounters1793980800002, LegacyOrdersAndTradeLookups1793980800003],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    uuidExtension: 'pgcrypto',
  };
}
