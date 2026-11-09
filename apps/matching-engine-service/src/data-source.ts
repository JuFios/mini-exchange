import { ClosedReservationRelease1793980800006 } from './migrations/1793980800006-closed-reservation-release';
import { ReservationReleaseClaims1793980800005 } from './migrations/1793980800005-reservation-release-claims';
import { QuarantineLegacyState1793980800004 } from './migrations/1793980800004-quarantine-legacy-state';
import { LegacyOrdersAndTradeLookups1793980800003 } from './migrations/1793980800003-legacy-orders-and-trade-lookups';
import { RecoveryCounters1793980800002 } from './migrations/1793980800002-recovery-counters';
import { DataSourceOptions } from 'typeorm';
import { User } from './auth/entities/user.entity';
import { Order } from './orders/entities/order.entity';
import { Instrument } from './orders/entities/instrument.entity';
import {
  InstrumentState,
  OrderCommand,
  OrderRequest,
  Outbox,
  TradeRecord,
} from './database/engine-records';
import { InitialSchema1793980800000 } from './migrations/1793980800000-initial-schema';
import { Instruments1793980800001 } from './migrations/1793980800001-instruments';
import type { DatabaseEnv } from './config/env.validation';
import { PG_KEEPALIVE, PG_SESSION_OPTIONS } from './database/session-options';

export function engineDataSourceOptions(
  env: DatabaseEnv,
): Extract<DataSourceOptions, { type: 'postgres' }> {
  return {
    type: 'postgres',
    extra: {
      options: PG_SESSION_OPTIONS,
      ...PG_KEEPALIVE,
      // Черга за з’єднанням під сплеском не повинна давати 500 за 3 с; недоступну БД виявляє /ready.
      connectionTimeoutMillis: 10000,
    },
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    username: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    entities: [
      User,
      Order,
      Instrument,
      InstrumentState,
      OrderCommand,
      OrderRequest,
      Outbox,
      TradeRecord,
    ],
    migrations: [
      InitialSchema1793980800000,
      Instruments1793980800001,
      RecoveryCounters1793980800002,
      LegacyOrdersAndTradeLookups1793980800003,
      QuarantineLegacyState1793980800004,
      ReservationReleaseClaims1793980800005,
      ClosedReservationRelease1793980800006,
    ],
    synchronize: false,
    migrationsRun: false,
    installExtensions: false,
    uuidExtension: 'pgcrypto',
  };
}
