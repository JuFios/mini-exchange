import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateDatabaseEnv, validateEnv } from './config/env.validation';
import { ledgerDataSourceOptions } from './data-source';
import { ReconciliationQuery, toPeriod } from './reconciliation/reconciliation-query';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ReconciliationService } from './reconciliation/reconciliation.service';

// Окремий модуль не запускає consumer: другий consumer у групі забирав би записи в основного.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ledgerDataSourceOptions(validateDatabaseEnv(process.env)),
    }),
    ReconciliationModule,
  ],
})
class ReconcileModule {}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' }, instrument: { type: 'string' } },
  });
  const period = toPeriod(Object.assign(new ReconciliationQuery(), values));
  const app = await NestFactory.createApplicationContext(ReconcileModule, { logger: ['error'] });
  try {
    const report = await app.get(ReconciliationService).run(period);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    await app.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
