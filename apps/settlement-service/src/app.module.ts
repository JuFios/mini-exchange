import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateDatabaseEnv, validateEnv } from './config/env.validation';
import { ledgerDataSourceOptions } from './data-source';
import { ConsumerModule } from './consumer/consumer.module';
import { ReservationsModule } from './reservations/reservations.module';
import { WalletsModule } from './wallets/wallets.module';
import { TradesModule } from './trades/trades.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ledgerDataSourceOptions(validateDatabaseEnv(process.env)),
    }),
    TradesModule,
    ReservationsModule,
    WalletsModule,
    ConsumerModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
